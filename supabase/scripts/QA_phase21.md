# QA Record — Phase 21

## Private Pilot Launch Preparation

This document records the verification status for Phase 21 checkpoints.

---

## Checkpoint 21A-0 — Pre-launch mobile admin/pro event duration usability fix

**Status: Complete ✓ — manual QA passed; pnpm tsc and pnpm build pass**

### What was fixed

The admin/pro event creation sheet (`CreateEventSheet.tsx`, Step 2) previously used
a plain `<input type="number">` for duration. On mobile this produced a poor
experience: no quick presets, a numeric spinner that was hard to tap accurately, and
no real-time "ends at" feedback on selection.

This fix is scoped strictly to the mobile usability of the duration field in
admin/pro event creation. Member court booking duration behavior (`CalendarShell.tsx`)
is unchanged.

### Files changed

| File                                          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/(app)/calendar/CreateEventSheet.tsx` | Replaced `<input type="number">` with preset pill buttons (30/45/60/90/120 min) plus a Custom mode that reveals a `inputMode="numeric"` text input. Added `DURATION_PRESETS` constant, `isCustomDuration` and `customDurationText` state, `handleCustomDuration` handler, `customDurationValid` derived value. Updated `selectType` to reset duration mode when an event type is chosen. Continue button gated on `customDurationValid`. |

No migrations. No RLS changes. No RPC changes. No changes to member court booking.

### New duration UX

- **Six pill buttons** on Step 2: 30 min / 45 min / 60 min / 90 min / 120 min / Custom.
- The pill matching the selected event type's `default_duration_minutes` is pre-highlighted.
  If the default is not in the preset list (e.g. 75 min), Custom mode is pre-activated.
- Tapping a preset sets the duration immediately; the "ends at" label updates in real time.
- Tapping **Custom** reveals a compact text input pre-filled with the current duration.
  - Uses `type="text" inputMode="numeric"` for a clean numeric keyboard on mobile.
  - Inline "Enter a whole number." error shown when text is non-empty and invalid.
  - Continue button remains disabled until the value is a valid positive integer.
- Admin/pro event duration is not restricted to the preset list — Custom accepts any
  positive whole number, preserving existing admin/pro flexibility.

### Manual QA results

- [x] **Admin — 60 min preset (mobile):** Opened create-event sheet as Admin; "60 min"
      pill pre-highlighted on a 60-minute default event type; tapped the pill; "ends at"
      label updated correctly; proceeded through courts → confirm; event created with
      correct duration.
- [x] **Admin — 90 min preset (mobile):** Tapped "90 min" pill; "ends at" updated;
      event created with duration 90 min.
- [x] **Admin — Custom duration (mobile):** Tapped Custom; numeric input appeared
      pre-filled; entered 75; "ends at" updated to reflect 75 min; completed creation;
      duration confirmed correct.
- [x] **Empty/invalid Custom input disables Continue:** Cleared custom field; Continue
      stayed disabled; typed "abc"; "Enter a whole number." error shown; Continue stayed
      disabled. Cleared and typed a valid integer; Continue enabled.
- [x] **Pro event creation:** Pro role opens create-event sheet; same preset pills
      present; behavior identical to Admin.
- [x] **Desktop regression:** Preset pills render and wrap correctly on desktop; Custom
      input usable with keyboard; full step flow (event type → date/time → courts →
      confirm) completes without visual breakage.
- [x] **Member court booking unchanged:** Member booking sheet still shows exactly
      four pills — 30 min / 60 min / 90 min / 120 min — with no 45 min option and no
      Custom pill. Behavior identical to Phase 20D-B.

---

### Deferred UX note

**Future UX polish (post-pilot):** Evaluate whether admin court reservation creation,
court blocking/maintenance creation, and event creation should share a more consistent
mobile creation pattern after pilot feedback is collected. The three flows currently
use different field layouts and input patterns that could benefit from a unified
bottom-sheet component pass during a post-pilot UX polish phase.

---

## Checkpoint 21A — Production Data Cleanup Planning

**Status: Complete ✓ — decision made; no data cleanup required**

### Decision

**Option A selected:** Keep the existing `riverside` club as the permanent operator
sandbox. Do not delete QA test accounts. Do not clean QA test data. Create a new,
clean pilot club for real pilot use.

Riverside and all QA accounts remain fully isolated from the pilot club by RLS.
Pilot users see only their own club's data.

### Admin role management

Documented in `supabase/scripts/README_bootstrap_new_club.md` under
**"Changing the first admin"**. Key rules:

- Invite the new admin via `/admin/members` → verify their access → then
  deactivate or demote the original admin.
- Keep at least one active admin at all times.
- No email-change feature exists; invite with the new address and deactivate
  the old account.

No migrations. No code changes. No data deleted.

---

## Checkpoint 21B — Pilot Club Bootstrap

**Status: Complete ✓ — new pilot club provisioned; verification checklist passed**

### What was done

The `bootstrap_new_club` SQL function was run via the Supabase SQL Editor using
`supabase/scripts/bootstrap_new_club.sql`. A new pilot club was provisioned from
scratch with no relation to the Riverside sandbox club.

No migrations. No code changes. No data cleanup or deletion performed.

### Pilot club configuration

| Field               | Value                                           |
| ------------------- | ----------------------------------------------- |
| Club name           | North Shore Towers                              |
| Slug                | `north-shore-towers`                            |
| Timezone            | `America/New_York`                              |
| Courts              | 5 — Court 1, Court 2, Court 3, Court 4, Court 5 |
| Booking window      | 14 days                                         |
| Cancellation window | 24 hours                                        |
| Cancellation grace  | 5 minutes                                       |
| App URL             | `https://court-time.vercel.app`                 |

### Verification checklist

**Database rows (run in Supabase SQL Editor)**

- [x] Club row exists:

  ```sql
  select id, name, slug, timezone, created_at
  from clubs
  where slug = 'north-shore-towers';
  -- Expected: 1 row; name = 'North Shore Towers'; timezone = 'America/New_York'
  ```

- [x] Five courts exist:

  ```sql
  select name, display_order, is_active
  from courts
  where club_id = (select id from clubs where slug = 'north-shore-towers')
  order by display_order;
  -- Expected: 5 rows; Court 1–Court 5; all is_active = true
  ```

- [x] Club settings exist:

  ```sql
  select booking_window_days, cancellation_window_hours, cancellation_grace_minutes
  from club_settings
  where club_id = (select id from clubs where slug = 'north-shore-towers');
  -- Expected: 1 row; 14 / 24 / 5
  ```

- [x] Operating hours exist (7 rows, one per day):

  ```sql
  select day_of_week, opens_at, closes_at, is_closed
  from operating_hours
  where club_id = (select id from clubs where slug = 'north-shore-towers')
  order by day_of_week;
  -- Expected: 7 rows; all is_closed = false
  ```

- [x] Event types exist (5 standard types):

  ```sql
  select key, label, default_capacity, default_duration_minutes
  from event_types
  where club_id = (select id from clubs where slug = 'north-shore-towers')
  order by key;
  -- Expected: 5 rows
  ```

- [x] First admin invite generated:
  ```sql
  select code, role, email, expires_at, accepted_at, revoked_at
  from club_invites
  where club_id = (select id from clubs where slug = 'north-shore-towers')
  order by created_at desc
  limit 1;
  -- Expected: 1 row; role = 'admin'; accepted_at = null; revoked_at = null;
  --           expires_at at least 14 days from bootstrap date
  ```

**First admin onboarding**

- [x] First admin Auth account created in Supabase dashboard (Authentication →
      Users → Add user; Auto Confirm User checked; temporary password set).
- [x] Invite URL (`https://court-time.vercel.app/join/<code>`) and temporary
      password delivered to the first admin out of band.
- [x] First admin signed in at `/sign-in` with temporary password.
- [x] First admin visited the invite URL → clicked **Accept Invitation** →
      redirected to `/welcome` → entered name → redirected to `/calendar`.
- [x] Invite row updated in DB:
  ```sql
  select accepted_at, accepted_by
  from club_invites
  where club_id = (select id from clubs where slug = 'north-shore-towers')
  order by created_at desc
  limit 1;
  -- Expected: accepted_at is not null; accepted_by = first admin's user UUID
  ```
- [x] First admin profile row correct:
  ```sql
  select p.role, p.status, p.first_name, p.last_name, c.slug
  from profiles p
  join clubs c on c.id = p.club_id
  where c.slug = 'north-shore-towers';
  -- Expected: role = 'admin'; status = 'active'; first_name and last_name set
  ```

**First admin page access**

- [x] `/admin/members` — loads; member list visible (admin only).
- [x] `/admin/courts` — loads; Court 1–Court 5 visible.
- [x] `/admin/settings` — loads; booking rules, operating hours, branding sections
      visible; settings values match bootstrap configuration.
- [x] `/admin/audit-log` — loads; `accept_invite` entry visible for the first
      admin's join action.
- [x] `/admin/events` — loads.
- [x] `/calendar` — loads; Court 1–Court 5 columns visible; timezone correct.

**Riverside sandbox isolation**

- [x] Riverside club row unchanged:
  ```sql
  select id, name, slug, timezone
  from clubs
  where slug = 'riverside';
  -- Expected: still present; name and slug unchanged
  ```
- [x] Riverside court count unchanged:
  ```sql
  select count(*) as court_count
  from courts
  where club_id = (select id from clubs where slug = 'riverside');
  -- Expected: 5
  ```
- [x] No North Shore Towers data visible to a Riverside-scoped session (RLS
      enforced by `current_user_club_id()`; cross-club data isolation confirmed
      by existing Phase 20B RLS checks).

---

## Checkpoint 21C — Pilot Club Configuration and Admin/Pro Training Prep

**Status: In progress — complete all items before moving to Phase 21D**

This checkpoint ensures North Shore Towers is fully configured for real use,
that the admin and any pro users understand how to operate the platform
day-to-day, and that a member-facing explanation is ready before friendly
users are invited.

No code changes. No migrations. No data deletion.

---

### Part 1 — North Shore Towers configuration checklist

Work through this as the admin before inviting anyone. Everything in this
section is done through the app or Supabase SQL Editor.

**1A — Club settings verified**

Open `/admin/settings`. Confirm the following match the intended pilot setup
and edit any values that need to change before members arrive.

- [x] Club name displays correctly as **North Shore Towers** in the app header.
- [x] Booking window shows **14 days** (adjust if the club wants a shorter or
      longer advance-booking horizon).
- [x] Cancellation window shows **24 hours** (adjust to match the club's policy).
- [x] Cancellation grace period shows **5 minutes** (adjust if needed).
- [x] Waitlist offer window is set (check the value; adjust to match how long
      the club wants to give a waitlisted member to accept a spot offer).

**1B — Courts verified**

Open `/admin/courts`. Confirm:

- [x] Five courts are listed: Court 1, Court 2, Court 3, Court 4, Court 5.
- [x] All five are **active** (toggle is on).
- [x] Court names match what members would recognize. Rename any court now
      if the club uses different names (e.g. "Clay 1", "Hard Court", etc.).
- [x] Court display order is correct. Drag to reorder if needed.

**1C — Operating hours verified**

Open `/admin/settings` → Operating Hours. Confirm:

- [x] Hours for each day of the week match the club's actual open/close times.
      The bootstrap default is 08:00–20:00 for all 7 days — update any day
      that differs (e.g. shorter weekend hours, closed Monday).
- [x] Any day the club is always closed (e.g. Monday) has **Closed** toggled on.
- [x] Navigate to `/calendar` and verify that slots outside the configured
      hours appear greyed/unavailable.

**1D — Booking and cancellation rules verified**

- [] As a member account (or sandbox Riverside account), attempt to navigate
  to a date beyond the booking window in `/calendar`. Slots should be
  unavailable past that horizon.
- [ ] Confirm the cancellation window and grace values are correct by reviewing
      the logic with the admin: members cannot cancel inside the window unless
      they are still within the grace period after booking.

**1E — Logo and theme/branding**

Open `/admin/settings` → Club Branding.

- [ ] Decide whether to upload a club logo before inviting members. A logo makes
      the app feel real to pilot users; it can be added or changed at any time.
      Upload a JPEG or PNG under 2 MB if available.
- [ ] Select a theme color that matches the club's brand. Default is
      **Classic Gray**; other options are available in the theme selector.
- [ ] After changing the theme, navigate to `/calendar` and confirm the accent
      color has updated.

**1F — First real-looking test event**

Before inviting friendly users, create at least one future event so the
calendar is not empty on day one.

- [ ] Admin navigates to `/calendar` → taps a future time slot → creates
      an event (e.g. a Round Robin or Clinic).
- [ ] Event appears on the calendar with the correct date, time, and court.
- [ ] Admin opens the event detail sheet and confirms capacity, duration, and
      title look correct.
- [ ] Optionally create a second event on a different day so the `/events`
      page shows a list rather than a single item.

---

### Part 2 — Admin training checklist

Walk the pilot admin through each area before they invite anyone else. The
goal is that the admin can operate the club independently. Check each item
when the admin has successfully performed the action themselves, not just
watched a demonstration.

**`/admin/settings`**

- [ ] Admin locates and updates operating hours for one day; verifies the
      change reflects in `/calendar`.
- [ ] Admin adds a date override (e.g. closes a future date); verifies the
      date is blocked in `/calendar`; removes the override.
- [ ] Admin saves a booking rule change (e.g. adjusts the booking window by
      1 day); verifies the value persists after a page reload; restores the
      original value.
- [ ] Admin sends a test announcement; confirms the notification appears in
      their own bell within a few seconds (Realtime delivery).
- [ ] Admin understands the logo upload and theme selectors and where to find
      them again.

**`/admin/courts`**

- [ ] Admin renames a court; verifies the new name appears in the calendar
      column header; renames it back.
- [ ] Admin reorders courts using drag-and-drop; verifies calendar column
      order updates; restores original order.
- [ ] Admin toggles a court inactive; verifies it disappears from the calendar;
      re-activates it.

**`/admin/members`**

- [ ] Admin creates a **member** invite with no email restriction; copies the
      invite link; understands that the link must be shared manually — no email
      is sent automatically.
- [ ] Admin creates an **email-restricted** invite (enters the invitee's email);
      understands that only that exact email address can use the link.
- [ ] Admin understands the invite link must start from the production URL
      (`https://court-time.vercel.app/join/...`) for email confirmation to
      route correctly.
- [ ] Admin can locate a member in the list and change their role (member ↔ pro).
- [ ] Admin can change a member's status (active → inactive) and understands
      that deactivated members are blocked from booking and joining events at the
      RPC level but can still sign in.
- [ ] Admin understands that to transfer or add an admin, they invite with role
      **admin**, verify access, then demote or deactivate the old admin. At least
      one active admin must always exist. See `README_bootstrap_new_club.md` →
      "Changing the first admin."

**`/admin/events`**

- [ ] Admin creates an event using the create-event sheet (event type → title →
      date/time/duration → courts → capacity → confirm).
- [ ] Admin opens a roster sheet on an existing event; adds a member; confirms
      the occupancy count on the event card updates without a page reload.
- [ ] Admin adds a guest to an event roster; confirms the guest appears and
      capacity count reflects it.
- [ ] Admin removes a participant; confirms the roster and count update; if a
      waitlisted member exists, confirms an offer is extended.
- [ ] Admin uses **Offer Spot** manually to bypass FIFO for a specific waitlisted
      member; confirms only one offer can be active at a time.
- [ ] Admin uses **Force Confirm** to place a waitlisted member directly into
      the confirmed list regardless of capacity.
- [ ] Admin cancels an event; confirms all confirmed/waitlisted/offered members
      receive an `event_cancelled` notification in their bell.

**`/admin/audit-log`**

- [ ] Admin opens the audit log and can read the human-readable labels for
      each recent action.
- [ ] Admin understands the audit log is admin-only and not visible to members.

**`/calendar`**

- [ ] Admin understands they see the same calendar view as members but can also
      tap reservation blocks to see the owner and admin-cancel if needed.
- [ ] Admin understands that their own court reservations as a player are booked
      from this same calendar (they are a member too).

**`/profile/notifications`**

- [ ] Admin opens their notification preferences and understands which
      notification kinds are toggleable and which are always delivered
      (e.g. `event_cancelled` is mandatory regardless of preferences).
- [ ] Admin understands the bell icon shows unread count and updates in real
      time without a page refresh.
- [ ] Admin understands that SMS is not currently configured and only in-app
      bell notifications are active. The SMS section in `/admin/settings` will
      show "SMS not configured" — this is expected and not an error.

---

### Part 3 — Pro training checklist

A pro has access to `/admin/events` only among the admin routes. All other
`/admin/*` routes redirect to `/calendar`. Walk through these items with any
pro-role users.

**`/admin/events` — roster management**

- [ ] Pro navigates to `/admin/events`; confirms the full event list loads and
      roster buttons are visible.
- [ ] Pro opens a roster and confirms they can: add a member, add a guest,
      remove a participant, force confirm, offer spot, expire an offer.
- [ ] Pro confirms they cannot access `/admin/members`, `/admin/courts`,
      `/admin/settings`, or `/admin/audit-log` — each redirects cleanly to
      `/calendar`.

**Event creation**

- [ ] Pro taps a calendar slot or uses the create-event sheet to create an event;
      confirms all four steps complete (type → date/time/duration → courts →
      capacity); confirms the event appears on the calendar.
- [ ] Pro understands the duration preset pills (30/45/60/90/120 min) and the
      Custom option for non-standard durations.

**Waitlist and offer behavior**

- [ ] Pro understands the FIFO waitlist flow: when a confirmed participant is
      removed or leaves, the oldest waitlisted member is offered a spot
      automatically and receives a notification.
- [ ] Pro understands they can bypass FIFO manually using **Offer Spot** and
      that only one active offer can exist at a time.
- [ ] Pro understands **Force Confirm** places a member directly into the
      confirmed list and may put the event over capacity — this is intentional
      administrative override behavior and is recorded in the audit log.
- [ ] Pro understands **Expire** removes an active offer without auto-advancing
      the waitlist; the admin or pro must manually offer the next person.

**Calendar view**

- [ ] Pro confirms `/calendar` loads correctly with all courts visible.
- [ ] Pro can book their own court reservation from the calendar as a player.
- [ ] Pro understands tapping their own booked block shows a cancel option;
      tapping another member's block shows no action (member privacy).

---

### Part 4 — Member-facing explanation points

Prepare these talking points before inviting friendly users. These do not need
to be a formal document — a short message or verbal briefing is sufficient.

**How invite links work**

Members receive a `/join/<code>` URL that is unique to them (or shared if no
email restriction was set). The link is valid for 14 days. They must open it
from the production URL (`https://court-time.vercel.app/join/...`) — not a
locally-forwarded or copied link — for email confirmation to work correctly.

**How to create an account**

Members who do not have an existing account visit the invite link → tap
**Create account** → enter their email and a password → receive a confirmation
email from `Court Time <no-reply@court-time.app>` → click the link in the
email → are automatically signed in, their invite is accepted, and they land
on `/welcome` to set their name → then `/calendar`.

Members who already have an account visit the invite link → tap **Sign in to
accept** → sign in → tap **Accept Invitation** → land on `/calendar`.

**How to book and cancel a court**

Tap any open time slot on the calendar to open the booking sheet. Select
duration (30/60/90/120 min), confirm. The booked slot appears immediately on
the calendar labeled "You." To cancel: tap the "You" block to open the
reservation detail sheet and tap **Cancel Booking**, or go to `/my-schedule`
and cancel from there. Cancellation is blocked within 24 hours of the start
time (the club's cancellation window) unless the booking was made within the
last 5 minutes (grace period).

**How to join and waitlist for events**

Go to `/events` to see all upcoming events. Tap **Join Event** if there is
open capacity — the spot is confirmed immediately. Tap **Join Waitlist** if the
event is full — a position number is shown. If a spot opens up, the first
person on the waitlist receives an offer notification in their bell. They have
a window to accept or pass. If they pass or the window expires, the next person
on the waitlist is offered. Members can leave a confirmed event or leave the
waitlist at any time from `/events` or `/my-schedule`.

**How notifications work**

The bell icon in the top bar shows a count of unread notifications. It updates
in real time — no page refresh needed. Tap the bell to see all notifications.
Tap one to mark it as read. Some notification kinds (e.g. event cancellations)
are always delivered regardless of preferences. Others (e.g. reservation
confirmation, event join confirmation) can be toggled off in
`/profile/notifications`.

**SMS is not enabled**

All notifications are in-app only (the bell). SMS text messages are not
currently configured. Members should not expect text alerts.

---

### Part 5 — Known caveats to mention during training

Communicate these to the admin, any pro, and friendly users before they start.
These are not bugs — they are known, intentional constraints for the pilot.

| Caveat                                                  | What to say                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Use the production URL**                              | Always open the app at `https://court-time.vercel.app`. Invite links and email confirmation links must be opened from this URL. A link forwarded from a locally-running version of the app will fail for new signups.                                                          |
| **Riverside is a sandbox**                              | The `riverside` club is used for developer testing only. It is fully isolated from North Shore Towers by the database's row-level security. Members of North Shore Towers never see Riverside data and vice versa.                                                             |
| **SMS is not configured**                               | The SMS section in Admin → Settings shows "SMS not configured." This is expected. In-app bell notifications are the only active channel for this pilot.                                                                                                                        |
| **Email notifications beyond auth emails are deferred** | Members receive Supabase Auth emails (signup confirmation, password reset) via Resend. They do not receive email copies of in-app notifications (e.g. "You have a new waitlist offer"). That feature is deferred to a post-pilot phase.                                        |
| **Member roster visibility**                            | Members can see the names of other confirmed and waitlisted participants on an event. This is intentional for the v1 pilot (tennis clubs typically post rosters) but can be revisited based on pilot feedback if privacy is a concern.                                         |
| **Admin/host as participant**                           | An admin or pro who creates an event is the host but does not automatically hold a participant spot. If they want to play in their own event, they must join it as a member from `/events` or `/calendar`. This is intentional v1 behavior and can be reconsidered post-pilot. |
| **Sticky header console warning**                       | Developers testing locally may see a Next.js console warning about `position: sticky` during navigation. This does not cause any visible problem and is cosmetic only.                                                                                                         |

---

### Part 6 — Go/no-go checklist for Phase 21D (friendly-user rollout)

All items below must be checked before inviting any real friendly users.
A friendly user is a real person on a real device using their real email address.

**Club configuration**

- [ ] Operating hours are correct for every day of the week.
- [ ] Court names are final (or clearly understood as placeholders).
- [ ] Booking window, cancellation window, and grace period match the club's
      actual policy.
- [ ] Waitlist offer window is set to a value the admin is comfortable with.
- [ ] At least one upcoming event exists so the calendar is not empty on day one.

**Admin readiness**

- [ ] Admin has completed all items in Part 2 (training checklist) and can
      operate every admin page independently.
- [ ] Admin can generate an invite link without operator assistance.
- [ ] Admin knows where to send members if they have trouble (email the operator
      or use the in-app Help page at `/help`).
- [ ] Admin understands the auth user deletion caveat: deactivate members via
      the app; do not attempt to delete Auth users from the Supabase dashboard.

**Pro readiness (if applicable)**

- [ ] Any pro-role users have completed Part 3 (pro training checklist).
- [ ] Pro understands their access is limited to `/admin/events`.

**Production environment**

- [ ] Vercel deployment is current — latest commit is on `main` and Vercel
      shows **Ready** (green) for the production deployment.
- [ ] Resend delivery is healthy — check the Resend dashboard for any recent
      delivery failures from the Phase 21B bootstrap invite and first admin
      password reset flow.
- [ ] No unresolved errors in Vercel function logs from Phase 21B activity.

**Pilot operating notes reviewed**

- [ ] All caveats in Part 5 have been communicated to the admin and any pro.
- [ ] Member-facing explanation points from Part 4 are ready to share with
      friendly users (verbally or as a short written briefing).
- [ ] The operator (you) is available to support the friendly users during their
      first week and has reviewed the support triage reference in the Phase 21
      plan.
