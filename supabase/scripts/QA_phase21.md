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
independently, and that member-facing talking points are ready before
friendly users are invited.

No code changes. No migrations. No data deletion.

---

### Part 1 — North Shore Towers configuration checklist

Work through this section as the admin before inviting anyone. Everything
here is done through the app at `https://court-time.vercel.app` or the
Supabase SQL Editor.

**1A — Club settings verified**

Open `/admin/settings`. Confirm each value matches the club's actual policy
and edit anything that needs to change before members arrive.

- [ ] Club name displays as **North Shore Towers** in the app header and on
      the sign-in page.
- [ ] Booking window is set correctly (default: 14 days). Adjust if the club
      wants a shorter or longer advance-booking horizon.
- [ ] Cancellation window is set correctly (default: 24 hours). Adjust to
      match the club's stated cancellation policy.
- [ ] Cancellation grace period is set correctly (default: 5 minutes). This
      is the window after booking during which a member can cancel even if
      they are already inside the cancellation window.
- [ ] Waitlist offer window is set. This controls how long an offered spot is
      held for a waitlisted member before it is considered expired. Adjust to
      a value the admin is comfortable enforcing.

**1B — Courts verified**

Open `/admin/courts`. Confirm:

- [ ] Five courts are listed: Court 1, Court 2, Court 3, Court 4, Court 5.
- [ ] All five courts are **active** (toggle is on for each).
- [ ] Court names match what members would recognize. If the club uses specific
      names (e.g. "Hard Court A", "Clay 1"), rename the courts now. Names can
      be changed at any time from this page.
- [ ] Court display order matches the physical layout or the club's preferred
      order. Drag to reorder if needed.

**1C — Operating hours verified**

Open `/admin/settings` → Operating Hours. Confirm:

- [ ] Open and close times for each day of the week match the club's actual
      hours. The bootstrap default is 08:00–20:00 for all 7 days.
- [ ] Any day the club is always closed (e.g. Monday) has **Closed** toggled
      on for that day.
- [ ] After saving any changes, navigate to `/calendar` and verify that time
      slots outside the configured hours appear greyed and cannot be tapped.

**1D — Booking and cancellation rules verified**

- [ ] Sign in as a member account (or use the Riverside sandbox) and navigate
      to a date beyond the booking window in `/calendar`. Slots beyond that
      date should appear unavailable.
- [ ] Confirm the cancellation policy is understood by the admin: members
      cannot cancel inside the cancellation window unless the booking was made
      within the grace period. Walk through one example to verify the logic
      matches expectation.

**1E — Logo and theme/branding**

Open `/admin/settings` → Club Branding.

- [ ] Decide whether to upload a club logo before inviting members. A logo
      makes the app feel credible to pilot users; it can be added or changed
      at any time. Upload a JPEG or PNG under 2 MB if one is available.
- [ ] Select a theme color that matches the club's identity. Default is
      **Classic Gray**. After changing, navigate to `/calendar` and confirm
      the accent color has updated club-wide.

**1F — First real-looking event**

Before inviting friendly users, create at least one future event so the
calendar is not empty on day one.

- [ ] Admin taps a future time slot on `/calendar` → creates an event
      (e.g. "Round Robin" or "Beginner Clinic") with a realistic title,
      capacity, and duration.
- [ ] Event appears on the calendar at the correct date, time, and court.
      Open the event detail sheet and confirm the title, capacity, and
      duration display correctly.
- [ ] Optionally create a second event on a different day so `/events` shows
      a list rather than a single item.

**1G — First admin account status**

- [ ] First admin has accepted their invite and can sign in at the production
      URL (`https://court-time.vercel.app`).
- [ ] First admin has completed `/welcome` and their first name and last name
      are set (visible in `/profile`).
- [ ] First admin has reset their password from the temporary password set
      during bootstrap (via `/forgot-password` or prompted after first sign-in).
- [ ] First admin profile is confirmed in the database:
  ```sql
  select p.first_name, p.last_name, p.role, p.status
  from profiles p
  join clubs c on c.id = p.club_id
  where c.slug = 'north-shore-towers';
  -- Expected: role = 'admin'; status = 'active'; names populated
  ```

**1H — Pro account decision**

Decide before Phase 21D whether a pro-role user is needed for the
friendly-user rollout.

- [ ] **Decision recorded:** Is a pro account required before inviting
      friendly users? A pro can create and manage events and rosters but
      cannot access club settings, courts, members, or the audit log.
      If no pro is needed yet, this can be deferred until a real club
      pro or instructor joins. Mark N/A if not applicable for Phase 21D.
- [ ] If yes: pro account is invited via `/admin/members` → role **pro**,
      invite accepted, and pro training (Part 3) is completed before
      friendly-user rollout begins.

---

### Part 2 — Admin training checklist

Walk the pilot admin through each area before they invite anyone else.
The goal is that the admin can operate the club independently without
operator assistance. Check each item when the admin has successfully
performed the action themselves — not just watched a demonstration.

**`/admin/settings` — club-wide configuration**

*Purpose: configure operating hours, booking rules, date overrides,
announcements, and club branding. This is the primary control panel for
how the club operates.*

- [ ] Admin updates operating hours for one day and verifies the change
      reflects in `/calendar`; restores the original value.
- [ ] Admin adds a date override marking a future date as closed; verifies
      the date is fully blocked in `/calendar`; deletes the override.
- [ ] Admin sends a test announcement and confirms it appears in their own
      notification bell within a few seconds without refreshing the page.

**`/admin/courts` — court management**

*Purpose: rename, reorder, and activate or deactivate individual courts.
Court names and order appear directly in the member-facing calendar.*

- [ ] Admin renames a court; verifies the new name appears in the calendar
      column header immediately; renames it back.
- [ ] Admin reorders courts; verifies the calendar column order updates;
      restores the original order.

**`/admin/members` — invites and member management**

*Purpose: invite new members and pros, manage roles, and deactivate
accounts. This is the only way to onboard new users — there is no
self-serve signup.*

- [ ] Admin creates a **member** invite with no email restriction; copies
      the invite link; understands the link must be shared manually (no
      email is sent automatically by the app).
- [ ] Admin creates an **email-restricted** invite and understands that only
      the exact email address entered can use that link.
- [ ] Admin locates a member and changes their role (member ↔ pro) and
      understands the access difference.
- [ ] Admin changes a member's status to **inactive** and understands:
      deactivated members are blocked from booking courts and joining events
      at the database level but can still sign in to the app. This is
      expected behavior.
- [ ] Admin understands the admin-transfer procedure: invite with role
      **admin**, verify the new admin has working access, then demote or
      deactivate the original. At least one active admin must exist at all
      times. See `README_bootstrap_new_club.md` → "Changing the first admin."

**`/admin/events` — event and roster management**

*Purpose: create events, manage rosters (add/remove participants, add
guests, handle waitlist offers), and cancel events. This page is also
accessible to pro-role users.*

- [ ] Admin creates an event end-to-end: type → title → date/time/duration
      → courts → capacity → confirm. Verifies it appears on `/calendar`.
- [ ] Admin cancels an event and confirms all affected members receive an
      `event_cancelled` notification in their bell.

**`/admin/audit-log` — activity history**

*Purpose: review a chronological log of all admin and member actions.
Useful for diagnosing issues during the pilot.*

- [ ] Admin opens the log and can read the human-readable action labels
      (e.g. "Added member to event", "Accepted invite").
- [ ] Admin understands the log is admin-only and never visible to members.

**`/calendar` — court booking view**

*Purpose: the primary day-view grid for court reservations. Admins see
the same view as members but can tap any reservation to see the owner
and cancel it if needed.*

- [ ] Admin books a court reservation for themselves as a player and
      verifies the slot shows "You" on the calendar.
- [ ] Admin taps another member's reservation block and confirms they can
      see the booking detail and an admin-cancel option.

**`/profile/notifications` — notification preferences**

*Purpose: control which in-app notification kinds are delivered to this
account. Some kinds are mandatory and cannot be turned off.*

- [ ] Admin opens notification preferences and identifies at least one
      toggleable kind (e.g. reservation confirmed) and one mandatory kind
      (e.g. event cancelled — always delivered regardless of preference).
- [ ] Admin understands the bell updates in real time and that SMS shows
      "not configured" in `/admin/settings` — this is expected.

---

### Part 3 — Pro training checklist

A pro has access to `/admin/events` only among the admin-area routes.
All other `/admin/*` routes redirect to `/calendar`. Skip this section
if no pro account is being set up before Phase 21D.

**Access and restrictions**

- [ ] Pro navigates to `/admin/events`; confirms the full event list loads
      and roster buttons are visible.
- [ ] Pro confirms they cannot access `/admin/members`, `/admin/courts`,
      `/admin/settings`, or `/admin/audit-log` — each should redirect
      cleanly to `/calendar` with no error page or data exposure.

**Creating events**

- [ ] Pro taps a future time slot or opens the create-event sheet from the
      calendar; completes all four steps (type → date/time/duration →
      courts → capacity); confirms the event appears on the calendar.
- [ ] Pro understands the duration preset pills (30/45/60/90/120 min) and
      the Custom option for non-standard durations.

**Cancelling events**

- [ ] Pro understands that events cannot be edited after creation — only
      cancelled. To change time, duration, or courts, the event must be
      cancelled and re-created.
- [ ] Pro cancels a test event from `/admin/events`; confirms affected
      members receive an `event_cancelled` notification.

**Roster management**

- [ ] Pro opens a roster sheet on a scheduled event and confirms they can:
      add a member from the dropdown, add a guest by name, remove a
      confirmed participant, use **Force Confirm** on a waitlisted member,
      use **Offer Spot** to manually offer a specific waitlisted member, and
      use **Expire** to remove an active offer.
- [ ] Pro confirms the event card occupancy count updates immediately after
      each roster mutation — no page reload required.

**Waitlist and offer behavior**

- [ ] Pro understands the automatic FIFO flow: when a confirmed participant
      is removed or leaves, the next waitlisted member receives an offer
      notification automatically.
- [ ] Pro understands **Offer Spot** bypasses FIFO and that only one active
      offer can exist at a time — the button is blocked if an offer is
      already open.
- [ ] Pro understands **Force Confirm** may put the event over capacity and
      that this action is logged in the audit log.
- [ ] Pro understands **Expire** removes the active offer without
      auto-advancing the queue; the next offer must be issued manually.

**Calendar view**

- [ ] Pro confirms `/calendar` loads with all courts visible.
- [ ] Pro can book their own court reservation as a player.
- [ ] Pro understands tapping their own booked block shows a cancel option;
      tapping another member's block shows no action.

---

### Part 4 — Member-facing explanation points

Prepare these talking points before inviting friendly users. A short
verbal briefing or a simple message is sufficient — no formal document
is required.

**Invite links**

Members receive a `/join/<code>` URL. The link is valid for 14 days. It
must be opened from `https://court-time.vercel.app/join/...` on a real
device or browser — not a locally-forwarded URL — for email confirmation
to route correctly.

**Account creation and email confirmation**

New members: visit the invite link → tap **Create account** → enter email
and password → receive a confirmation email from
`Court Time <no-reply@court-time.app>` → click the link → account
confirmed, invite auto-accepted, redirected to `/welcome` to set name →
then `/calendar`.

Existing members (already have an account): visit the invite link → tap
**Sign in to accept** → sign in → tap **Accept Invitation** → `/calendar`.

If the confirmation email does not arrive: check spam. If the link is
clicked more than once or prefetched by the mail client it will show
"link expired" — in that case, use **Forgot password** to set a new
password, then sign in and visit the invite URL again.

**Booking a court**

Tap any open time slot on `/calendar` → booking sheet opens → select
duration (30 / 60 / 90 / 120 min) → tap **Confirm Booking**. The slot
appears immediately on the calendar labeled "You."

**Cancelling a booking**

Two ways: tap the "You" block on the calendar → **Cancel Booking** in the
detail sheet. Or go to `/my-schedule` → find the reservation → cancel.
Cancellation is blocked if the session starts within the club's
cancellation window (24 hours by default) and the booking was not made
within the last 5 minutes (grace period).

**Joining an event**

Go to `/events` → tap **Join Event** if capacity is available. Spot is
confirmed immediately and a confirmation notification appears in the bell.
To leave: tap **Leave Event** from `/events` or `/my-schedule`.

**Joining a waitlist**

If an event is full, tap **Join Waitlist**. A position number is shown.
When a spot opens, the first waitlisted member receives an offer
notification in their bell with a deadline to accept. Tap **Accept Spot**
to confirm, or **Pass** to decline (the offer moves to the next person).
To leave the waitlist: tap **Leave Waitlist** from `/events` or
`/my-schedule`.

**In-app notifications**

The bell icon in the top bar shows the unread count and updates in real
time without a page refresh. Tap it to see all notifications; tap one to
mark it read. Some kinds (e.g. event cancellation) are always delivered.
Others can be turned off per-kind in `/profile/notifications`.

**Notification preferences**

Go to `/profile` → **Notifications** (or navigate directly to
`/profile/notifications`). Each toggleable notification kind has an on/off
switch. Mandatory kinds (e.g. event cancelled, waitlist offer) are always
delivered regardless of preferences.

**SMS is not enabled**

All notifications are in-app only (the bell). No SMS text messages are
sent. Members should not expect text alerts during this pilot.

**App-generated email notifications are deferred**

Members receive Supabase Auth emails (signup confirmation, password reset)
via `no-reply@court-time.app`. They do not receive email copies of in-app
notifications (e.g. "You have a waitlist offer" or "Your booking is
confirmed"). Email notification delivery is a post-pilot feature.

---

### Part 5 — Known caveats to communicate during training

Share these with the admin, any pro, and friendly users before the pilot
begins. These are not bugs — they are known, intentional constraints.

| Caveat | What to say |
| --- | --- |
| **Use the production URL only** | Always open the app at `https://court-time.vercel.app`. Invite links, confirmation links, and password-reset links must be opened at this URL. A link from a locally-running version of the app will not work for email confirmation. |
| **North Shore Towers is the pilot club** | The active pilot club is North Shore Towers (`north-shore-towers`). All member invites, events, and bookings belong to this club. Members of North Shore Towers see only North Shore Towers data. |
| **Riverside is a developer sandbox** | The `riverside` club exists for developer testing only. It is fully isolated from North Shore Towers by row-level security. No one outside the development team should attempt to join or access it. |
| **SMS is not configured** | The SMS section in Admin → Settings shows "SMS not configured." This is expected and not an error. In-app bell notifications are the only active delivery channel during this pilot. |
| **App-generated email notifications are deferred** | Signup confirmation and password-reset emails are delivered via Resend. Notifications generated by the app (offers, event cancellations, booking confirmations) are in-app only. Email delivery for those is a post-pilot feature. |
| **Member roster visibility** | Members can see the names of other confirmed and waitlisted participants on an event. This is intentional for the v1 pilot but can be revisited after pilot feedback if privacy is a concern. |
| **Admin/host as participant** | An admin or pro who creates an event does not automatically hold a participant spot. If they want to play, they must join the event as a member from `/events` or `/calendar`. This is intentional v1 behavior. |
| **Deactivated users can still sign in** | Deactivating a member via `/admin/members` blocks them from booking courts, joining events, and joining waitlists (enforced at the database level). It does not prevent them from signing in to the app. This is expected behavior. |
| **Keep at least one active admin** | If all admin accounts are deactivated or demoted, there is no in-app recovery path. Admin access would need to be restored directly via the Supabase SQL Editor. Always verify a new admin has working access before changing an existing admin's role or status. |

---

### Part 6 — Go/no-go checklist for Phase 21D (friendly-user rollout)

All items below must be checked before inviting any real friendly users.
A friendly user is a real person on a real device using their real email.

**North Shore Towers settings verified**

- [ ] Operating hours are correct for every day of the week and reflect the
      club's actual schedule.
- [ ] Court names are final, or it is clearly understood they are
      placeholders that will be renamed before the broader pilot.
- [ ] Booking window, cancellation window, and grace period match the club's
      stated policy.
- [ ] Waitlist offer window is set to a value the admin has agreed to.

**Admin can access all admin pages**

- [ ] Admin signs in at the production URL and confirms all five admin pages
      load without errors: `/admin/members`, `/admin/courts`,
      `/admin/settings`, `/admin/events`, `/admin/audit-log`.
- [ ] Admin has completed Part 2 (training checklist) and can perform every
      listed action independently, without operator assistance.
- [ ] Admin can generate an invite link and copy it without operator help.

**Courts look correct**

- [ ] `/calendar` shows exactly five court columns with the correct names.
- [ ] All courts are active. No court is inadvertently deactivated.
- [ ] Slots outside configured operating hours appear greyed and cannot be
      tapped.

**At least one event exists for testing**

- [ ] At least one scheduled future event appears in `/events` and on
      `/calendar` so the calendar is not empty when friendly users arrive.
- [ ] The event has a realistic title, capacity, and duration.

**Invite flow tested for pilot club**

- [ ] Admin has generated at least one invite link for North Shore Towers
      and confirmed the link begins with
      `https://court-time.vercel.app/join/` and opens the correct
      `/join/<code>` page when visited in a browser.
- [ ] The invite and signup flow has been tested end-to-end for a brand-new
      account (not just an existing account accepting an invite) — either
      during Phase 21B or as part of Part 2 training.

**No unresolved pilot blockers**

- [ ] All Phase 20E-C pilot blockers are resolved (confirmed: Issues #4, #5,
      #8 fixed in Phase 20D; EventDetailSheet capacity fixed in Phase 20E-A).
- [ ] No new functional regressions have been introduced since Phase 20E-C.
- [ ] No unresolved errors in Vercel function logs or Supabase API logs from
      Phase 21B or Phase 21C activity.
- [ ] Vercel shows **Ready** (green) for the current production deployment.
- [ ] Resend dashboard shows no delivery failures for recent auth emails.

**Support and feedback process identified**

- [ ] Admin knows how to reach the operator if something goes wrong (direct
      contact method agreed — email, message, etc.).
- [ ] Friendly users will be told to report issues directly to the admin or
      operator, not through any public channel.
- [ ] Operator has reviewed the support triage reference in this Phase 21
      plan and is available during the friendly users' first week of use.

---

## Checkpoint 21D — Friendly-User Rollout

**Status: Complete ✓ — Wave 1 passed; all go/no-go criteria met**

This checkpoint runs a controlled first wave of real users through North
Shore Towers before any broader pilot invitation. All items in Phase 21C
(configuration and training) must be complete before this checkpoint begins.

No code changes. No migrations. No data deletion.

---

### Part 1 — Rollout scope

**Wave size:** 2–4 trusted users. Small enough to catch issues quickly and
manage support personally; large enough to exercise the full member flow
across multiple real accounts.

**Roles:**

- Start with **member** role for all friendly users. This exercises the
  core member experience (invite, signup, booking, events, notifications)
  that the majority of real pilot members will have.
- A **pro** account may be added during or after Phase 21D if a pro is
  part of the pilot plan, but is not required to complete this rollout.

**URL:** All friendly users must use `https://court-time.vercel.app`
exclusively. This is not optional — invite links and email confirmation
links are built against this URL and will not work from any other origin.

**Sandbox isolation:** Riverside is the operator sandbox. Friendly users
must not be given Riverside invite links or credentials. Any user who
somehow lands in Riverside will see test data and not the real pilot
club. Verify every invite link sent is for North Shore Towers:

```sql
-- Confirm the invite belongs to North Shore Towers
select ci.code, c.name as club_name, c.slug, ci.role, ci.email,
       ci.created_at, ci.expires_at
from club_invites ci
join clubs c on c.id = ci.club_id
where ci.code = '<paste-invite-code-here>';
-- Expected: club_name = 'North Shore Towers'; slug = 'north-shore-towers'
```

---

### Part 2 — Invite plan

**Who sends invites:** The pilot club admin sends all Phase 21D invites
from `/admin/members`. The operator does not send invites directly.

**How to create an invite:**

1. Admin navigates to `/admin/members` → **Invite**.
2. Select role **member**.
3. For friendly users whose emails are known in advance: enter the email
   in the email-restriction field. This ensures the link can only be
   used by that person.
4. Copy the generated `/join/<code>` URL.
5. Share it with the user via direct message, email, or text — whatever
   channel the admin normally uses to communicate with this person.

**Email restriction recommendation:** Use email-restricted invites for
all Phase 21D users. The friendly-user wave is small enough that the admin
knows each person's email, and restriction prevents the link from being
forwarded and accidentally consumed by someone else.

**What to tell users before sending the invite:**

Send this context along with the invite link, before they tap it:

> You're one of the first people to try the North Shore Towers booking app.
> Follow the link below to create your account and join the club.
>
> A few things to know:
> - Open the link on your phone or tablet — it's designed for mobile.
> - You'll be asked to confirm your email. The confirmation link comes
>   from `no-reply@court-time.app`; check spam if you don't see it within
>   a minute or two.
> - After confirming, you'll land on the app and can start exploring.
> - Court bookings and events are real — any booking you make will show
>   up for other members, so keep that in mind while testing.
> - If anything feels broken or confusing, let me know directly.
>
> Link: `https://court-time.vercel.app/join/<code>`

---

### Part 3 — Friendly-user test script

Ask each friendly user to work through this sequence on their own, on a
real mobile device, without hand-holding. The goal is to surface issues
that only appear during unassisted, real-device use.

Check each item as you confirm the user has completed it (either by
their report or by checking the DB/admin pages).

**Account setup**

- [ ] User receives the invite link and opens it at
      `https://court-time.vercel.app/join/<code>`.
- [ ] `/join/<code>` page shows the club name (North Shore Towers), the
      invited role (member), and a **Create account** option.
- [ ] User taps **Create account** → enters their email and a password →
      submits the signup form.
- [ ] Confirmation email arrives from `Court Time <no-reply@court-time.app>`
      within a few minutes. User checks spam if not in inbox.
- [ ] User clicks the confirmation link → lands directly on `/welcome`
      (no additional sign-in step required; invite is auto-accepted).
- [ ] User enters first and last name on `/welcome` → submits → lands on
      `/calendar`.
- [ ] Verify in DB:
  ```sql
  select p.first_name, p.last_name, p.role, p.status,
         ci.accepted_at
  from profiles p
  join clubs c on c.id = p.club_id
  join auth.users u on u.id = p.id
  left join club_invites ci on ci.accepted_by = p.id
    and ci.club_id = c.id
  where c.slug = 'north-shore-towers'
    and u.email = '<user-email>';
  -- Expected: role = 'member'; status = 'active'; names set;
  --           accepted_at is not null
  ```

**Calendar and court booking**

- [ ] User opens `/calendar`. Court columns are visible. Today's date is
      highlighted. Slots outside operating hours are greyed.
- [ ] User taps an open future time slot → booking sheet opens showing
      court name, date, time, and duration options (30/60/90/120 min).
- [ ] User selects a duration and taps **Confirm Booking**. Slot appears
      on the calendar labeled "You."
- [ ] Verify in DB:
  ```sql
  select status, starts_at, ends_at
  from reservations
  where owner_user_id = (
    select id from auth.users where email = '<user-email>'
  )
  order by created_at desc
  limit 1;
  -- Expected: status = 'confirmed'
  ```

**Booking cancellation — from Calendar**

- [ ] User taps their "You" reservation block on the calendar.
- [ ] Reservation detail sheet opens showing court, date, and time.
- [ ] "Booked by" line is NOT shown (member is viewing their own booking).
- [ ] User taps **Cancel Booking** → booking is removed from the calendar.
- [ ] Verify: reservation row shows `status = 'cancelled'` in the DB.

**Booking cancellation — from My Schedule**

- [ ] User books a second court reservation.
- [ ] User navigates to `/my-schedule`. The new reservation is listed.
- [ ] User taps **Cancel** on the reservation row → reservation disappears
      from My Schedule.
- [ ] Verify: second reservation row shows `status = 'cancelled'` in the DB.

**Event join**

- [ ] User navigates to `/events`. At least one upcoming event is listed.
- [ ] User taps **Join Event** on an event with open capacity.
- [ ] Event card updates to show **Joined** badge. Participant count
      increases.
- [ ] User opens `/my-schedule`. The event is listed with status
      **Confirmed**.

**Waitlist**

- [ ] If an event is at capacity (or create a second event at capacity=1
      with a confirmed participant): user taps **Join Waitlist** on the
      full event.
- [ ] Event card shows **Waitlisted** badge with a position number.
- [ ] User navigates to `/my-schedule`. The event is listed with status
      **Waitlisted** and a position number.
- [ ] Mark N/A if no full event is available during Phase 21D; test in
      Phase 21E with more users.

**Notifications**

- [ ] Bell icon in the top bar shows an unread count after signup, booking,
      and event join actions.
- [ ] User taps the bell → notification sheet opens. Notifications for
      reservation confirmation, event join, and any announcements are listed.
- [ ] User taps a notification → it is marked as read. Unread count
      decreases. Re-opening the sheet shows it as read.
- [ ] Verify bell count updates in real time: while the user's session is
      open, admin sends an announcement from `/admin/settings`. User's bell
      count increments within a few seconds without a page refresh.

**Notification preferences**

- [ ] User navigates to `/profile/notifications`.
- [ ] Toggleable preference kinds are listed with on/off switches.
- [ ] User turns off **Reservation confirmed**.
- [ ] User books another court reservation.
- [ ] No `reservation_confirmed` notification appears in the bell.
- [ ] User turns **Reservation confirmed** back on.
- [ ] User books another court reservation.
- [ ] `reservation_confirmed` notification appears in the bell.

---

### Part 4 — Admin monitoring checklist during rollout

Check these during and immediately after each friendly user completes
their test script.

**`/admin/members`**

- [ ] Each user who accepted an invite appears in the members list with
      role **member** and status **active**.
- [ ] No unexpected accounts have appeared (verify count matches the
      number of invites sent).

**`/admin/events`**

- [ ] Event participant counts reflect the friendly users' join actions.
      Roster sheet shows each user by name in the correct section
      (Confirmed, Waitlisted, etc.).
- [ ] No duplicate participant rows exist for any user.

**`/admin/audit-log`**

- [ ] `accept_invite` entries are present for each friendly user.
- [ ] No unexpected or anomalous actions appear.

**Supabase Auth logs (if invite or signup issues are reported)**

Open Supabase dashboard → **Logs** → **Auth**. Look for:

- Failed OTP exchange or code exchange errors for the affected user.
- `email_not_confirmed` or `invalid_credentials` errors during sign-in
  attempts.
- Duplicate signup attempts from the same email address.

Common causes and actions:

| Symptom | Likely cause | Action |
| --- | --- | --- |
| User never receives confirmation email | Resend delivery failure or spam filter | Check Resend logs; resend invite if needed |
| Confirmation link shows "expired or invalid" | Link clicked more than once, or mail client prefetched it | User should use `/forgot-password` to set a new password, then sign in and visit the invite URL again |
| User lands on `/pending-invite` instead of `/welcome` | Navigated to the app root before confirmation | Direct them back to the original invite URL |
| User lands on `/sign-in?error=confirmation_failed` | Code exchange failed | Same as above — use `/forgot-password` path |

**Resend logs (if confirmation emails are not received)**

Open `resend.com` dashboard → **Emails**. Filter by recipient address.
Confirm delivery status is `delivered`. If status is `bounced` or
`failed`, the email address may be incorrect or blocked by the recipient's
mail server. Correct the address and resend the invite.

---

### Part 5 — Friendly-user feedback questions

Collect responses from each friendly user after they complete the test
script. A brief message or short conversation is sufficient — no formal
survey required.

| # | Question | What to listen for |
| --- | --- | --- |
| 1 | **Was signup clear?** Did you know what to expect at each step? | Confusion about the confirmation email; unexpected redirects; unclear error messages |
| 2 | **Was booking a court clear?** Did the calendar make sense? | Duration selector confusing; time slots unclear; court columns not obvious |
| 3 | **Was cancelling a booking clear?** Did you find the cancel option from both the Calendar and My Schedule? | Missed the "You" tap target on calendar; did not find My Schedule |
| 4 | **Was joining an event clear?** Did you understand your status (Joined, Waitlisted, Offered)? | Difference between Join Event and Join Waitlist unclear; offer deadline not noticed |
| 5 | **Were notifications understandable?** Did you know what each notification meant? | Notification copy unclear; bell count did not update in real time |
| 6 | **Did anything feel broken or confusing on mobile?** | Tap targets too small; sheet does not scroll correctly; layout breaks at their screen size; any action that did not respond |
| 7 | **Any other feedback?** | Open-ended; note anything unexpected for the post-pilot backlog |

---

### Part 6 — Stop/rollback criteria

If any of the following are observed during Phase 21D, stop inviting
additional friendly users immediately and investigate before continuing.

These are not the same as deferred items — they represent conditions where
continuing the rollout would cause real confusion or data integrity issues.

| Condition | Immediate action |
| --- | --- |
| Invite or signup flow is broken (confirmation email not delivered, link errors not recoverable via `/forgot-password`) | Pause rollout; investigate Resend and Supabase Auth logs; do not send additional invites until resolved |
| Users cannot book a court (booking sheet does not open, RPC errors on confirm) | Pause rollout; check Vercel function logs for RPC errors; identify regression |
| Users cannot cancel a booking (cancel action fails or is not reachable from Calendar or My Schedule) | Pause rollout; check cancellation window logic and server action errors |
| A North Shore Towers user can see Riverside data, or vice versa | **Immediate stop**; this is a cross-club RLS failure; do not invite more users until the isolation is confirmed restored |
| A user sees another member's private data that they should not have access to | **Immediate stop**; investigate RLS policies before continuing |
| Admin cannot manage members or events (admin pages error or do not load) | Pause rollout; check Vercel deployment status and function logs |
| Notification bell shows incorrect or misleading state (e.g. real-time count not updating, notifications delivered to wrong user) | Pause rollout; verify the `notifications` table is in the `supabase_realtime` publication and RLS policies are correct |

---

### Part 7 — Go/no-go criteria for Phase 21E (broader pilot)

All items below must be checked before expanding beyond the Phase 21D
friendly-user wave.

**Signup and onboarding**

- [ ] At least 2 friendly users completed signup end-to-end without
      operator intervention — invite link, email confirmation, `/welcome`,
      `/calendar`.
- [ ] No unresolved invite or signup failures. Any failure that occurred
      has been root-caused and either fixed or confirmed as a one-off
      (e.g. spam filter, user error).

**Core member flows**

- [ ] At least 1 court booking and cancellation (from Calendar or My
      Schedule) completed successfully by a real user.
- [ ] At least 1 event join completed successfully.
- [ ] Notification bell updated in real time for at least 1 user during
      their session.

**Waitlist (if tested)**

- [ ] At least 1 waitlist join completed successfully, or explicitly
      deferred to Phase 21E with a note that waitlist was not exercised
      in Phase 21D due to insufficient event volume.

**Data integrity**

- [ ] Zero instances of cross-club data exposure (North Shore Towers ↔
      Riverside or any other club).
- [ ] All friendly-user profiles are correctly scoped to
      `north-shore-towers` in the DB.
- [ ] No duplicate participant or reservation rows exist for any user.

**No unresolved pilot blockers**

- [ ] All stop/rollback conditions in Part 6 were either not triggered
      or were triggered, investigated, and resolved before rollout
      continued.
- [ ] No new regressions were introduced since Phase 20E-C.

**Feedback disposition**

- [ ] All feedback collected from friendly users has been reviewed.
- [ ] Each reported issue is either: (a) fixed before Phase 21E, (b)
      explicitly deferred with a written note, or (c) confirmed as
      working-as-intended with an explanation ready for real pilot members.
- [ ] No feedback issue is left unreviewed or in an unknown state.

---

### Wave 1 results — operator sign-off

**All go/no-go criteria for Phase 21E are met. Rollout can proceed.**

Wave 1 ran after Phase 21X was deployed and the production smoke test passed.
2 friendly users invited as members. No operator intervention was required after
invites were sent.

| Flow | Result |
| --- | --- |
| Invite created and sent | ✓ Pass |
| Email confirmation delivered | ✓ Pass |
| `/welcome` profile completion | ✓ Pass |
| `/calendar` loads for new member | ✓ Pass |
| Court booking | ✓ Pass |
| Cancel booking from Calendar | ✓ Pass |
| Cancel booking from My Schedule | ✓ Pass |
| Event join | ✓ Pass |
| Notification bell — real-time update | ✓ Pass |
| Notification panel — desktop dropdown (Phase 21X fix) | ✓ Pass |
| Notification panel — mobile bottom sheet | ✓ Pass |
| North Shore Towers data only visible to NST members | ✓ Pass — no cross-club exposure |
| Riverside data not visible to friendly users | ✓ Pass |

No unresolved pilot blockers. No cross-club data exposure observed. No regressions
since Phase 20E-C.

---

### Resume note — after Phase 21X

**Phase 21X (UX & Performance Stabilization) is complete and deployed to production.**

All 21X sub-phases (21X-B through 21X-H) have been merged to `main` and Vercel
has deployed the current build. Live on production:

- Desktop fixed sidebar and mobile bottom nav (21X-B)
- Calendar desktop layout — wider columns, centered for low court counts, anchored FAB (21X-C)
- Route-level loading skeletons for `/calendar`, `/events`, `/my-schedule` (21X-F)
- Calendar and events query parallelization (21X-G2-A)
- Notification panel desktop clipping fix — dropdown on desktop, bottom sheet on mobile (21X-H)

Friendly-user rollout can resume after a final production smoke test confirms no
regression in the flows pilot members will use.

**Resumption constraints for Phase 21D:**

- First wave: **2 trusted users only.**
- Role: **member** for all first-wave users.
- Invites: **email-restricted** where the user's email is known in advance.
- URL: **`https://court-time.vercel.app` only.** Invite links and email
  confirmation links are built against this URL and will not work from any
  other origin.
- Riverside remains the operator sandbox. Do not send friendly users any
  Riverside invite link or credentials.
- **Notifications must be included in the test script.** A desktop notification
  panel clipping issue was found and fixed in Phase 21X-H. Verify the notification
  panel opens correctly on both desktop and mobile with a real session before the
  rollout proceeds.

---

### Execution checklist

Use this checklist to run the Phase 21D rollout. Refer to Parts 1–7 above for
full context on each step. Do not duplicate those sections here — this list is
the step-by-step operator action sequence only.

**Step 1 — Final production smoke test (before inviting anyone)**

- [ ] Open `https://court-time.vercel.app/sign-in`. Page loads without errors.
- [ ] Sign in as North Shore Towers admin. Confirm redirect to `/calendar`.
- [ ] **Desktop notification panel:** click bell → panel opens as a dropdown
      below the header, right-aligned; no overlap with sidebar; click-away
      closes it; no drag handlebar visible.
- [ ] **Mobile notification panel:** tap bell → bottom sheet slides up with drag
      handle; sheet does not overlap bottom nav; swipe or tap backdrop dismisses.
- [ ] `/admin/members`, `/admin/events`, `/admin/settings` all load without error.
- [ ] Create a test event (admin) → confirm it appears on `/admin/events` and
      `/events`. Cancel the test event before proceeding.
- [ ] Vercel dashboard: current production deployment shows **Ready** (green).
- [ ] Resend dashboard: no delivery failures for recent auth emails.

**Step 2 — Create the first 2 member invites**

- [ ] Signed in as North Shore Towers admin at `https://court-time.vercel.app`.
- [ ] `/admin/members` → **Invite** → role **member** → enter first user's email
      address (email-restricted) → copy the `/join/<code>` URL.
- [ ] Verify the invite belongs to North Shore Towers before sending:
  ```sql
  select ci.code, c.name as club_name, c.slug, ci.role, ci.email
  from club_invites ci
  join clubs c on c.id = ci.club_id
  where ci.code = '<paste-invite-code-here>';
  -- Expected: club_name = 'North Shore Towers'; slug = 'north-shore-towers'
  ```
- [ ] Repeat for the second friendly user.
- [ ] Both invite URLs saved before closing the invite sheet.

**Step 3 — Send invite message to friendly users**

Use the message template from Part 2 above. Include with each invite:

- [ ] Their personal invite URL (`https://court-time.vercel.app/join/<code>`).
- [ ] Reminder to open it from `https://court-time.vercel.app`, not a forwarded
      or cached link.
- [ ] Note that court bookings and events are real and visible to other members.
- [ ] Your direct contact method for reporting issues.

**Step 4 — Monitor signup and invite flow**

After each user taps the invite link:

- [ ] Watch `/admin/members` — user appears as **pending** until they accept.
- [ ] After signup completes: user status changes to **active**; role shows
      **member**.
- [ ] If confirmation email not received within 5 minutes: check Resend →
      **Emails** → filter by recipient address. If `bounced` or `failed`,
      correct the email address and resend. If `delivered`, ask user to check
      spam.
- [ ] If user lands on `/pending-invite` instead of `/calendar`: direct them
      back to the original invite URL.
- [ ] If user lands on `/sign-in?error=confirmation_failed`: direct them to
      `/forgot-password` to set a new password, then sign in and visit the
      invite URL.

**Step 5 — Have users complete the test script**

Ask each user to work through the flows from Part 3 (Friendly-user test script):

- [ ] Account setup: invite link → email confirmation → `/welcome` → `/calendar`.
- [ ] Book a court. Confirm booking appears in My Schedule.
- [ ] Cancel a booking from the **Calendar** view (tap their own block).
- [ ] Cancel a booking from **My Schedule**.
- [ ] Join an event from `/events`.
- [ ] Check the **notification bell** — confirm the badge updates in real time
      and the panel renders correctly (dropdown on desktop, bottom sheet on
      mobile). This is required; do not skip.
- [ ] Toggle a notification preference from `/profile/notifications`.
- [ ] Waitlist join — arrange a full event to trigger it. If not possible,
      note "waitlist not exercised in Phase 21D" and defer to Phase 21E.

**Step 6 — Capture feedback**

After each user completes the test script, collect responses to the seven
questions from Part 5:

- [ ] Signup: was the confirmation email step clear?
- [ ] Court booking: did the calendar make sense?
- [ ] Cancellation: was the cancel path found from both Calendar and My Schedule?
- [ ] Events: was Joined / Waitlisted / Offered status understood?
- [ ] Notifications: did the bell count update in real time? Was the panel easy
      to find and use on their device?
- [ ] Mobile usability: anything felt broken or hard to tap?
- [ ] Open-ended: anything else unexpected?

Record each response. Cross-check against the stop/rollback criteria in Part 6
before inviting any additional users beyond the first two.

**Step 7 — Go/no-go for Phase 21E**

After both friendly users complete the test script, check every item in Part 7
above. If all criteria are met:

- [ ] Mark Checkpoint 21D **Complete ✓** at the top of this section.
- [ ] Proceed to Phase 21E (broader pilot launch).

If any stop criterion from Part 6 was triggered and is not yet resolved:

- [ ] Do not proceed to Phase 21E.
- [ ] Document the issue below and resolve it before re-evaluating.

---

## Phase 21X — UX & Performance Stabilization

**Status: Complete ✓ — all sub-phases implemented; pnpm tsc and pnpm build pass**

Branch: `phase-21x-ux-performance`

This pass ran between Checkpoint 21A-0 and the resumption of friendly-user
rollout. It addressed responsive layout, perceived performance, and measurable
query latency without touching auth, RLS, database schema, migrations, RPCs,
Supabase policies, or `force-dynamic`. No new product features were added.

---

### 21X-B — Responsive App Shell

**Files changed:**
- `src/components/SideNav.tsx` — NEW; `"use client"`, `hidden md:flex`, fixed
  left sidebar at `w-56` with 4 nav tabs using `usePathname` for active state.
- `src/components/BottomNav.tsx` — added `md:hidden` so bottom nav is hidden
  on desktop (sidebar takes over).
- `src/app/(app)/layout.tsx` — imported `SideNav`; added `md:pl-56` offset on
  the main content wrapper so content clears the fixed sidebar on desktop.
- `src/app/globals.css` — added `--surface`, updated `--page-fill-height`
  (mobile: `calc(100dvh - 3.5rem - 4rem - env(safe-area-inset-bottom, 0px))`;
  desktop: `calc(100dvh - 3.5rem)`), `.app-main-content`, and `--accent` theme
  tokens.

**What this achieves:**

On screens ≥ 768px, a fixed left sidebar replaces the bottom nav. Mobile
layout (≤ 767px) is unchanged — bottom nav still present, sidebar hidden.

---

### 21X-C — Calendar Desktop Layout

**Files changed:**
- `src/app/(app)/calendar/CalendarShell.tsx` — `MAX_colW` raised from 180 →
  320px; `rowH` is now responsive (40–64px, computed via ResizeObserver based
  on available vertical space); `containerW` state + `fitsContainer` flag added
  to center low-court-count layouts instead of stretching to fill the container;
  outer wrapper made `position: relative`; FAB moved from `fixed bottom-20
  right-4` to `absolute bottom-4 right-4`; `--page-fill-height` CSS variable
  applied to the scroll container.
- `src/app/(app)/calendar/page.tsx` — added `max-w-[1440px] mx-auto w-full`
  wrapper around `<CalendarShell />` to cap grid width on ultra-wide displays.
- Six additional page files updated to use `style={{ height:
  "var(--page-fill-height)" }}` instead of hardcoded viewport heights.

**What this achieves:**

Calendar grid columns scale up to 320px on desktop rather than being capped
at 180px. When fewer courts are selected (1–2), the grid centers horizontally
rather than leaving blank space to the right. FAB is anchored to the calendar
container edge rather than the viewport edge, so it does not overlap sidebar or
bottom nav. Row height expands smoothly with available vertical space.

**Issue fixed during 21X-C:** Removed `minWidth: "100%"` from both the grid
wrapper and sticky court header — this was the root cause of the blank white
area to the right when only 1–2 courts were selected.

---

### 21X-F — Perceived Performance / Loading States

**Files changed (all new):**

| File | Purpose |
| --- | --- |
| `src/app/(app)/loading.tsx` | Generic app-shell skeleton; fallback for all `(app)` routes without a specific `loading.tsx`. Renders inside layout's `{children}` slot — sidebar and bottom nav are already present from layout. |
| `src/app/(app)/calendar/loading.tsx` | Calendar-specific skeleton matching `CalendarShell` structure: date strip (8 circle pills), court filter chips (6), sticky court header row (33px), 10 time-slot rows (40px each, 5 columns, time-gutter at 52px). Wraps in `max-w-[1440px]` to match `calendar/page.tsx`. |
| `src/app/(app)/events/loading.tsx` | Events-specific skeleton matching `events/page.tsx`: header, page title block, date section header, 3 event card skeletons with pill/title/time/capacity rows. |
| `src/app/(app)/my-schedule/loading.tsx` | My Schedule-specific skeleton: no page-title block (matches actual page); date section header, 3 horizontal schedule item cards, second date group with 2 event-style cards (type pill + name + time). |

**What this achieves:**

Route-level `loading.tsx` files act as React Suspense boundaries at the segment
level. While the Server Component fetches Supabase data, the nearest `loading.tsx`
is shown immediately. Each skeleton is pixel-matched to the real page so there
is no layout shift on reveal. Pure `animate-pulse` CSS — zero JavaScript
overhead.

---

### 21X-G2-A — Low-Risk Query Parallelization

**Files changed:**

| File | Change |
| --- | --- |
| `src/app/(app)/calendar/page.tsx` | `clubs.select("timezone")` moved into the same `Promise.all` as courts, operating_hours, and operating_hours_override. All four queries now fire in parallel once `profile.club_id` is available. Removed `.gte("override_date", todayISO)` filter from the overrides query — table is small; CalendarShell filters by exact date. `clubTimezone` and `todayISO` derived after the parallel batch. |
| `src/app/(app)/events/page.tsx` | `clubs.select("timezone")` moved into a `Promise.all` with the events query. Both only need `profile.club_id`. Previously sequential; now parallel. |

**What this eliminates:**

Both pages had a hidden waterfall:
`getUser → profiles → clubs (timezone) → page data`.
After this change the chain is:
`getUser → profiles → [clubs + page data in parallel]`.

One sequential Supabase round-trip saved on both `/calendar` and `/events` on
every page load.

**Constraints respected:** No auth changes. No RLS changes. No schema changes.
No migrations. No `React.cache()` added. No `force-dynamic` changes. No caching
layer added. No server.ts changes.

---

### Route timing observations (dev server, warm connection)

These are approximate ranges measured in development. Production on Vercel
with warm Edge functions and connection pooling via Supabase will be faster.
First-render in dev has high variance due to cold module loading.

| Route transition | Approximate range | Notes |
| --- | --- | --- |
| `/calendar` → `/events` | ~460–495 ms | Parallelized clubs + events query in 21X-G2-A |
| `/events` → `/calendar` | ~600–655 ms | Slightly slower — 4 parallel queries vs. 2 |
| `/calendar` → `/my-schedule` | ~490 ms | Includes profile + two sequential queries |

These timings are illustrative. They depend on dev server state, Supabase edge
region, and connection pool warmth. Do not treat them as production benchmarks.

---

### Deferred work

| Item | Reason deferred |
| --- | --- |
| **21X-G3: Calendar SSR initial data** | Pass `initialReservations` and `initialEvents` as props from `calendar/page.tsx` to `CalendarShell` to eliminate the empty-grid flash on `/events → /calendar`. Deferred before pilot: touches sensitive date-boundary logic in `getDayBoundsUTC` / `tzOffsetMs`; app now feels acceptable without it; best revisited with test coverage post-pilot. |
| **DB-side optimization** | Short-circuit `getUser` / profiles with `React.cache()` or middleware session read; batch multi-day reservation queries. Deferred: requires `force-dynamic` audit and Supabase connection-pool analysis to size correctly. |
| **21X-D quick wins** | Tab labels, title text cleanup, empty state copy. Deferred to post-pilot UX polish. |
| **21X-E sheet changes** | Migrate remaining sheets to `BottomSheet` component. Deferred to Phase 17/18 backlog per prior decision. |

---

### Build and type-check status

```
pnpm tsc --noEmit   → no output (clean)
pnpm build          → succeeded; no new warnings introduced by 21X work
```

One pre-existing warning about the `/sign-up` route (`force-dynamic` + cookies)
was confirmed unrelated to all 21X changes.

---

### Manual QA checklist for 21X branch

Complete before merging to `main` and resuming friendly-user rollout.

**Responsive shell — mobile (< 768 px)**

- [ ] Bottom nav is visible on all `(app)` routes.
- [ ] Sidebar is not visible on mobile.
- [ ] `--page-fill-height` fills the viewport correctly accounting for the
      bottom nav and safe area insets (no overflow; no clipped content).
- [ ] `/calendar`, `/events`, `/my-schedule`, `/profile`, `/admin/*` all load
      without layout breakage on mobile.

**Responsive shell — desktop (≥ 768 px)**

- [ ] Fixed left sidebar is visible with 4 nav tabs.
- [ ] Active tab is highlighted based on current route.
- [ ] Bottom nav is not visible on desktop.
- [ ] Main content is offset by `md:pl-56` — no content hidden behind sidebar.
- [ ] `--page-fill-height` fills the remaining viewport height correctly (no
      bottom nav subtracted on desktop).

**Calendar desktop layout**

- [ ] Calendar grid columns reach up to 320 px on a wide screen; do not
      exceed that width regardless of viewport size.
- [ ] Selecting 1–2 courts: grid centers horizontally in the available area;
      no large blank white space to the right.
- [ ] Grid is capped at `max-w-[1440px]` on ultra-wide displays.
- [ ] FAB is positioned at the bottom-right of the calendar container, not
      the viewport edge; does not overlap the sidebar on desktop.
- [ ] Row height expands on tall viewports; time slots are more readable on
      desktop than on mobile.

**Loading skeletons**

- [ ] Navigating to `/calendar` on a slow connection (or with Network throttle
      in DevTools set to Slow 3G) shows the calendar skeleton (date strip +
      court chips + time grid) before the real page renders. No blank white
      flash.
- [ ] Same test for `/events`: skeleton shows page title block + 3 event card
      outlines.
- [ ] Same test for `/my-schedule`: skeleton shows date group header + 3
      schedule item cards (no page-title block).
- [ ] Generic `(app)/loading.tsx` is shown as fallback for any route that does
      not have its own `loading.tsx` (e.g. `/profile`).
- [ ] No layout shift when the real page replaces the skeleton — dimensions
      should be closely matched.

**Query parallelization — no regression**

- [ ] `/calendar` loads correctly with the correct timezone applied to the
      date strip and time slots.
- [ ] `/events` loads correctly with dates grouped by the club's timezone.
- [ ] All operating hours overrides are correctly applied in CalendarShell
      (verify by checking a date with a configured override if one exists in
      the sandbox).
- [ ] No errors in browser console or Vercel function logs related to the
      parallelized queries.

**Cross-cutting**

- [ ] Auth flow unchanged: `/sign-in` → `/calendar`; unauthenticated access to
      any `(app)` route redirects to `/sign-in`.
- [ ] RLS isolation unchanged: Riverside sandbox user cannot see North Shore
      Towers data and vice versa.
- [ ] Admin pages (`/admin/*`) load correctly on both mobile and desktop with
      the new shell.
- [ ] Notification bell updates in real time during a session (Supabase
      Realtime subscription unchanged).

---

### Recommendation

All 21X changes are non-breaking, additive (loading skeletons) or narrowly
scoped (column widths, query order). No auth, RLS, schema, or RPC changes were
made. Build and type-check are clean. After completing the manual QA checklist
above, merge `phase-21x-ux-performance` to `main` and resume Phase 21D
friendly-user rollout.

---

## Phase 21X-H — Notification Panel Desktop Layout Hotfix

**Status: Complete ✓ — manual QA passed; pnpm tsc and pnpm build pass**

Branch: `phase-21x-notification-panel-fix`

### Issue found

Production smoke testing after Phase 21X-B/C (responsive shell + desktop
sidebar) revealed that the notification panel was partially covered and visually
clipped on desktop. The panel was rendered via `BottomSheet`, which uses
`fixed bottom-0 left-0 right-0` — a full-width mobile drawer that does not
account for the desktop sidebar or the calendar layout. The drag handlebar was
also visible and functional on desktop, which is not appropriate for a
pointer-driven interface.

Booking, cancellation, event detail, and event roster sheets were not affected
because they are opened from within the content area and do not conflict with
the sidebar.

### Fix made

**File changed:** `src/components/NotificationSheet.tsx` only.

`NotificationSheet` now detects the screen breakpoint at mount using a lazy
`useState` initializer (`window.matchMedia("(min-width: 768px)").matches`) plus
a `useEffect` listener for resize. No mount flicker because the component only
renders after a user click, so `window` is always available.

- **Desktop (≥ 768px):** renders a `fixed top-14 right-4 z-50` dropdown
  panel — `w-96`, `max-height: min(60vh, 480px)`, scrollable content, border
  and shadow. A transparent `z-40` backdrop captures click-away. No drag
  handlebar.
- **Mobile (< 768px):** unchanged — `BottomSheet` with drag handle,
  `max-h-[55vh]` scrollable list, existing touch gesture behavior.

No changes to `NotificationBell`, `Header`, `BottomSheet`, auth, RLS, roles,
RPCs, migrations, database schema, Supabase policies, or notification backend
logic.

### Manual QA results

**Desktop**

- [x] Bell click opens a dropdown panel directly below the header, aligned to
      the right. No drag handlebar visible.
- [x] Panel does not overlap or clip behind the sidebar. Full panel content
      is visible and scrollable.
- [x] Calendar grid remains behind the panel cleanly — no z-index conflict.
- [x] Click anywhere outside the panel (including on the sidebar or calendar)
      closes the panel.
- [x] "Mark all read" button is visible and clickable; tapping it marks all
      notifications read and hides the button.
- [x] Individual unread notification rows are tappable; clicking marks the
      row read and decrements the bell badge.
- [x] Panel renders correctly in dark mode.

**Mobile**

- [x] Tap the bell → bottom sheet slides up with drag handlebar. Existing
      behavior unchanged.
- [x] Sheet does not overlap the bottom nav.
- [x] Swipe handlebar downward or tap backdrop → sheet dismisses.
- [x] "Mark all read" and individual read actions work correctly.

**No regression**

- [x] Booking detail sheet, cancellation sheet, event detail sheet, and event
      roster sheet open and close normally on both desktop and mobile.
      Unaffected by this change.
- [x] Bell unread count is correct before and after opening/closing the panel.

### Recommendation

Phase 21X (including 21X-H) is ready to merge. Merge
`phase-21x-notification-panel-fix` into `phase-21x-ux-performance`, then merge
`phase-21x-ux-performance` to `main` and resume Phase 21D friendly-user
rollout.

---

## Checkpoint 21E — Broader Pilot Rollout

**Status: Phases 21E-A through 21E-D complete — ready for controlled member pilot**

This checkpoint expands North Shore Towers from the 2-user friendly-user wave
(Phase 21D) to the full intended pilot audience. Phase 21D Wave 1 passed all
go/no-go criteria.

Phase 21E-A (app-generated email notifications) was implemented before broader
rollout. See the Phase 21E-A section below for deployment steps.

---

## Phase 21E-A — App-Generated Email Notifications

**Status: Complete ✓ — implemented on branch `phase21e-email-notifications`;
pnpm tsc and pnpm build pass**

### What was implemented

Email delivery for all 8 notification kinds via Resend. All email notifications
are default-ON and members can opt out of any category via Profile → Notification
preferences. In-app notification behavior is unchanged.

### Migration required before deploy

**`0055_expand_notification_preferences.sql`** — apply in Supabase SQL Editor
before or immediately after deploying this branch to production:

1. Adds `get_user_email(p_user_id uuid)` — security-definer function that
   reads `email` from `auth.users` without requiring the service-role key.
2. Expands the `notification_preferences.kind` CHECK constraint to all 8 kinds
   (previously only 4 were allowed).
3. Replaces `update_notification_preference` RPC with an expanded allowlist
   covering all 8 kinds.

`user_pref_enabled()` is **not changed** — it is already generic and returns
`coalesce(enabled, true)` for any kind (no row = ON by default).

### Vercel environment variables required

| Variable | Source | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | resend.com → API Keys | **Server-side only** — no `NEXT_PUBLIC_` prefix |

Domain `court-time.app` is already verified in Resend. Sender address is:
`Court Time <no-reply@court-time.app>` (same as Supabase Auth emails).

### Files changed

| File | Change |
| --- | --- |
| `supabase/migrations/0055_expand_notification_preferences.sql` | New migration — see above |
| `src/lib/email.ts` | New — `sendEmail()` (Resend wrapper) + `sendEmailNotification()` (shared dispatch helper) |
| `src/lib/email-templates.ts` | New — 8 template functions (inline HTML + plain-text fallback) |
| `src/app/(app)/calendar/actions.ts` | Added 7 email dispatch functions; wired into all 6 action entry points |
| `src/app/(app)/admin/settings/actions.ts` | Added `dispatchAnnouncementEmails`; wired into `sendAnnouncementAction` |
| `src/app/(app)/profile/notifications/NotificationPreferencesForm.tsx` | Expanded to 8 configurable kinds; removed mandatory section; updated footer note |
| `src/app/(app)/profile/notifications/page.tsx` | Updated description to mention email |
| `.env.example` | Added `RESEND_API_KEY` entry |
| `src/lib/db/types.ts` | Added `get_user_email` to Database Functions type |

### Architecture notes

- `sendEmailNotification` is the shared helper. Guards run in order:
  1. `RESEND_API_KEY` absent → return immediately (no delivery row written).
  2. `email_already_delivered(notification_id)` — security-definer duplicate
     guard; skips if a `sent` email row already exists for this notification.
  3. `user_pref_enabled(user_id, kind)` — security-definer preference check;
     records `opted_out` and returns if the user has disabled this kind.
  4. `get_user_email_for_notification(notification_id)` — security-definer email
     fetch; verifies caller is authenticated, in the same club as the
     notification, and is the recipient themselves OR has role admin/pro.
     Returns null on any authorization failure; email is not sent.
- Email uses the same `notification_deliveries` records as SMS (`channel = 'email'`).
  `p_provider = 'resend'` for all email records.
- When `RESEND_API_KEY` is unset: email dispatch returns immediately with no
  `notification_deliveries` row written. In-app and SMS are unaffected.
- SMS dispatch is unchanged. Email runs in a separate `try/catch` after each
  SMS dispatch so SMS and email failures are independent.
- Announcement emails exclude the sending admin (`actorUserId` check).
- Event cancellation emails exclude the actor who cancelled the event.

### SMS deferred note

SMS dispatch is tested internally via Admin → Settings → Send test SMS but is
not activated for members. The Twilio env vars must all be set to enable SMS.
Until then, `sendSms()` returns early with `"SMS is not configured."` and no
SMS is delivered. This behavior is unchanged by Phase 21E-A.

### Known limitations

- **Waitlist offer email**: when a regular member leaves an event and triggers a
  waitlist offer, `get_user_email_for_notification` returns null (caller is
  'member' role, target is a different member). The email is not sent. The
  in-app notification always delivers. Fix post-pilot: a dedicated server-side
  admin-context dispatch or a trusted internal route.
- **No per-channel preferences**: one toggle controls both email and in-app for
  the 4 originally-configurable kinds. For the 4 formerly-mandatory kinds
  (admin cancel, event cancel, waitlist offer, waitlist promoted), turning the
  toggle off stops email only; in-app notifications for those kinds still always
  deliver. Per-channel preferences are a post-pilot enhancement.

### Deployment checklist

Follow these steps in order. The migration must be applied before the app code
is deployed, because the app calls RPCs defined in the migration.

- [ ] **Step 1 — Add env var.** Add `RESEND_API_KEY` to Vercel → Settings →
      Environment Variables (Production; server-only — no `NEXT_PUBLIC_` prefix).
      Do not redeploy yet.
- [ ] **Step 2 — Apply migration.** Run `0055_expand_notification_preferences.sql`
      in Supabase SQL Editor. Confirm all 4 statements execute without error.
- [ ] **Step 3 — Deploy app code.** Push `phase21e-email-notifications` to `main`
      (or trigger a Vercel redeploy). The new RPCs from Step 2 will be available
      when the deployment goes live.
- [ ] **Step 4 — Production QA.** Trigger a court booking; check Resend dashboard
      (resend.com → Emails) for a delivered email within ~10 seconds.
- [ ] Verify: Profile → Notification preferences shows all 8 toggles; turning
      one off and back on saves without error.

### QA checklist for Phase 21E-A

**Email delivery (requires `RESEND_API_KEY` set in production)**

- [ ] Booking confirmed → member receives email with subject "Court booked — North Shore Towers"
- [ ] Admin cancels booking → member receives email "Your booking was cancelled — North Shore Towers"
- [ ] Member self-cancels → member receives email "Booking cancelled — North Shore Towers"
- [ ] Member joins event (confirmed spot) → receives email "You're in — North Shore Towers"
- [ ] Event cancelled → all participants receive email "Event cancelled — North Shore Towers" (actor excluded)
- [ ] Waitlist offer created → offered member receives email "Spot available — North Shore Towers"
- [ ] Member accepts waitlist offer → receives email "You're confirmed — North Shore Towers"
- [ ] Announcement sent → all members (except sender) receive email with announcement title as subject

**Preference opt-out**

- [ ] Member turns off "Booking confirmations" in Profile → Notification preferences → saves ✓
- [ ] Member books a court → no booking confirmation email is sent
- [ ] Member turns "Booking confirmations" back on → subsequent bookings resume sending email

**Email not configured (no `RESEND_API_KEY`)**

- [ ] With `RESEND_API_KEY` unset, all 8 notification flows complete normally
- [ ] No errors surfaced to the user; no `notification_deliveries` rows written for email
- [ ] In-app notification bell continues to work normally

---

## Phase 21E-B — SMS UI Hidden for Pilot Clarity

**Status: Complete ✓ — implemented on branch `phase21e-email-notifications`;
pnpm tsc and pnpm build pass**

### What was changed

SMS (Twilio) remains deferred and inactive for the pilot. The member-facing
SMS opt-in UI was hidden from `/profile` to avoid confusion — members seeing
the checkbox might assume they would receive text messages, which they will not.

**No schema changes. No Supabase data changes. No Twilio activation.**
All SMS backend code (`updateSmsPreference` action, `sms_opt_in` column,
`sendSms` utility, `dispatchXxxSms` dispatch functions) is preserved intact
and can be surfaced again when Twilio is configured.

### Files changed

| File | Change |
| --- | --- |
| `src/app/(app)/profile/ProfileEditForm.tsx` | Removed SMS opt-in section (checkbox, label, footnote) and all related dead state (`smsChecked`, `smsSaved`, `smsError`, `smsPending`, `handleSmsChange`). Removed `updateSmsPreference` import and `smsOptIn` prop. |
| `src/app/(app)/profile/page.tsx` | Removed `smsOptIn` prop from `<ProfileEditForm>` call. |
| `src/app/(app)/profile/notifications/NotificationPreferencesForm.tsx` | Removed the sentence about text messages following these preferences. New copy: "These settings control email delivery. Important in-app updates, such as cancellations by your club, may still appear in your notification bell." |

### SMS re-activation path (post-pilot)

To re-enable the member-facing SMS opt-in UI:

1. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` in Vercel.
2. Restore the `smsOptIn` prop and SMS section in `ProfileEditForm.tsx` and
   update `page.tsx` to pass `smsOptIn={profile?.sms_opt_in ?? false}`.
3. Update the `NotificationPreferencesForm` footer to mention text messages.
4. Test via Admin → Settings → Send test SMS to confirm Twilio delivery.

The `updateSmsPreference` server action and all dispatch code require no changes.

---

### Part 1 — Launch readiness status

All prerequisites for broader pilot launch are confirmed.

| Item | Status |
| --- | --- |
| North Shore Towers club bootstrapped | ✓ Complete (Phase 21B) |
| Pilot club configuration and training prep | ✓ Complete (Phase 21C) |
| Phase 21D Wave 1 — friendly-user smoke test | ✓ All flows passed |
| Phase 21X stabilization live on production | ✓ Desktop sidebar, loading skeletons, notification panel fix |
| Production URL | `https://court-time.vercel.app` — verified |
| Riverside sandbox isolation | ✓ No cross-club exposure observed in Wave 1 |
| No unresolved pilot blockers | ✓ Confirmed |

**Constraints that remain in effect for Phase 21E:**

- Production URL only: `https://court-time.vercel.app`. Never share localhost or
  Vercel preview URLs with pilot members.
- Riverside is the operator sandbox. Do not send any pilot member a Riverside
  invite link or credentials.
- Notifications must remain part of monitoring throughout Phase 21E. The desktop
  notification panel fix (21X-H) is live, but real-world usage at scale is the
  first production validation.
- Keep at least one active North Shore Towers admin at all times.

---

### Part 2 — Recommended rollout size

**Recommendation: 5–10 users for the next wave, not all-at-once unless the
total intended pilot group is ≤ 10.**

Rationale: Phase 21D validated the invite, signup, booking, cancellation, event,
and notification flows with 2 users. The system is ready for real use. However,
a few practical reasons to stay at 5–10 before going to the full group:

1. **Support bandwidth.** Any signup or confirmation issue requires the admin or
   operator to triage in real time. 5–10 users is manageable in a single pass;
   25+ simultaneous signups can create a queue of stuck users faster than one
   person can handle.
2. **Feedback signal.** A second wave of 5–10 gives you a meaningful feedback
   sample before the full group joins. If a flow is confusing to 3 of 10 users,
   you learn that before it affects 30.
3. **Invite management.** Email-restricted invites are easier to track at 5–10
   than at 20+. You can confirm each user accepted before the next batch.

**Exception:** If the total intended pilot group is 10 or fewer users, invite
everyone at once. The overhead of batching is not worth it at that scale.

If the operator knows the full group is small (≤ 10 total including Wave 1
users), proceed with a single invite batch for all remaining members.

---

### Part 3 — Invite execution plan

**Who creates invites:** The North Shore Towers admin. The operator does not
send invites directly.

**Step-by-step:**

1. Admin signs in at `https://court-time.vercel.app`.
2. Navigate to `/admin/members` → **Invite**.
3. Role: **member** for all standard pilot members. Use **pro** only if this
   person will actively manage events or rosters — not for regular members who
   want early access.
4. Enter the member's email address in the email-restriction field. This prevents
   the link from being accepted by anyone else.
5. Copy the `/join/<code>` URL.
6. Verify the invite before sending:
   ```sql
   select ci.code, c.name as club_name, c.slug, ci.role, ci.email
   from club_invites ci
   join clubs c on c.id = ci.club_id
   where ci.code = '<paste-invite-code-here>';
   -- Expected: club_name = 'North Shore Towers'; slug = 'north-shore-towers'
   ```
7. Send the invite link and the pilot launch message from Part 4 to the member
   via the channel the admin normally uses (email, text, messaging app).

**Batch guidance:**

- If the total remaining group is ≤ 10: create all invites in one session and
  send them all at once.
- If the group is > 10: send in batches of 5–8. Confirm each batch has accepted
  and onboarded before sending the next. This keeps the support queue manageable.

**Tracking who has accepted:**

Check `/admin/members` after sending each batch. Members show as **pending**
until they accept. Once they accept and complete `/welcome`, status shows
**active**. You can also run:

```sql
select
  p.display_name,
  p.email,
  p.role,
  p.status,
  ci.accepted_at,
  p.created_at
from profiles p
left join club_invites ci on ci.accepted_by = p.id
where p.club_id = (select id from clubs where slug = 'north-shore-towers')
  and p.role = 'member'
order by p.created_at desc;
```

This shows name, role, status, and when the invite was accepted for every
member in North Shore Towers.

---

### Part 4 — Pilot launch message

Send this message along with the invite link. Adapt the tone to fit how the
admin normally communicates with this group — the substance should remain the
same.

---

> **Subject (if email):** You're invited to the North Shore Towers booking app

> Hi [name],
>
> We're launching the pilot version of our court booking app for North Shore
> Towers, and you're in the first group of members to try it.
>
> **To get started, tap the link below and create your account:**
> [paste `/join/<code>` URL here]
>
> A few things to know before you tap:
>
> - Open the link on your phone — the app is designed for mobile, though it
>   also works on desktop.
> - After you create your account, you'll get a confirmation email from
>   `no-reply@court-time.app`. Check your spam folder if you don't see it
>   within a minute or two. You'll need to click that link before you can
>   sign in.
> - Once you're in, you can book a court, join events, and check notifications
>   using the navigation at the bottom of the screen.
> - This is a real booking system — any court you reserve will show as
>   unavailable to other members, so please only book what you plan to use.
>   You can cancel from the Calendar or from My Schedule.
> - If anything looks broken or confusing, let me know directly. This is the
>   pilot — your feedback matters.
>
> Questions? Reply here or reach me at [admin contact].

---

---

### Part 5 — First 48-hour monitoring checklist

Run these checks in the first 48 hours after sending the broader rollout
invites. No special tooling required — all checks are in the app or in the
Supabase/Resend dashboards.

**App — check once per day or after each signup batch**

- [ ] `/admin/members` — every invited member shows **active** status after
      they accept. No one stuck on **pending** for more than 24 hours without
      explanation (some people are slow; others may need a resend).
- [ ] `/admin/events` — events the admin created are visible with correct
      participant counts and occupancy. No phantom participants.
- [ ] `/admin/audit-log` — scan for any unexpected entries (errors, repeated
      failed actions, anything that looks like a system problem rather than
      user activity).

**Notification bell/panel — spot check after any event mutation**

- [ ] Create a test notification (e.g., announce an event) and confirm the
      bell badge updates in real time on an active member session.
- [ ] Open the notification panel on desktop: dropdown appears, no clipping,
      content scrolls.
- [ ] Open the notification panel on mobile: bottom sheet slides up correctly.

**Supabase Auth logs — check only if signup issues are reported**

1. Supabase dashboard → **Authentication** → **Users**.
2. Filter by email or creation date.
3. Look for users stuck in unconfirmed state (`email_confirmed_at` is null).
4. Check the **Logs** tab → **Auth** for OTP exchange errors, invalid code
   errors, or rate-limit hits.

**Resend logs — check if a member reports not receiving confirmation email**

1. Resend dashboard → **Emails** → filter by recipient address.
2. Confirm delivery status is `delivered`. If `bounced` or `failed`: check
   the email address for typos; resend the invite with the correct address.
3. If `delivered` but member did not receive it: ask them to check spam;
   the sender is `no-reply@court-time.app`.

**Feedback — ongoing**

- [ ] Each member's first 1–2 sessions: ask the feedback questions from
      Phase 21D Part 5 (same 7 questions).
- [ ] Log each response as: **fix now**, **defer to post-pilot**, or
      **training issue** (user confusion, not a bug).

---

### Part 6 — Support triage

Use this table when a member reports an issue or when monitoring reveals a
problem. Check the Condition column against what the member describes, then
follow the Action column.

| Condition | Likely cause | Immediate action |
| --- | --- | --- |
| Member never received invite | Admin sent to wrong email, or did not send yet | Check `/admin/members` — confirm invite was created. Re-create with correct email if needed. |
| Confirmation email not received | Resend delivery failure or spam filter | Check Resend logs; if `delivered`, ask member to check spam. If `bounced`/`failed`, correct email and resend. |
| Confirmation link shows "expired or invalid" | Link clicked more than once, or mail client pre-fetched it | Direct member to `/forgot-password` to set a new password; sign in; visit the invite URL. |
| Member lands on `/pending-invite` instead of `/calendar` | Navigated to app root before accepting invite | Direct them to the original `/join/<code>` URL. They must accept before accessing the app. |
| Member lands on `/sign-in?error=confirmation_failed` | Code exchange failed (link reuse) | Same as above — `/forgot-password` → sign in → visit invite URL. |
| Member cannot book a court | Booking window not open yet, or court unavailable | Check court availability on the calendar. Confirm `booking_window_days` covers the date they tried. If RPC error: check Vercel function logs. |
| Member cannot cancel a booking | Cancellation window has passed | Confirm the booking is within 24 hours of the court time. If still within window and cancel fails: check Vercel function logs for `cancel_reservation` errors. |
| Member cannot join an event | Event is full and no waitlist spot | Check capacity on `/admin/events`. If event is full, member lands on waitlist — expected behavior. |
| Notifications confusing or bell not updating | Real-time subscription not active | Ask member to refresh the page (re-establishes the Realtime subscription). If persistent: confirm `notifications` table is in the `supabase_realtime` publication (run `verify_production_setup.sql`). |
| Mobile layout issue | Device-specific rendering | Collect device/browser. Check if issue reproduces at the same screen size in DevTools. Log for post-pilot UX polish if not blocking. |
| Cross-club data concern (member sees wrong data) | **Critical — RLS policy failure** | **Immediate stop.** Do not invite additional members. Identify which club's data was exposed, to which user, and via which page. Do not resolve speculatively — investigate RLS policies before any rollout resumes. |

---

### Part 7 — Go/no-go criteria after Phase 21E

These criteria define when the pilot can be considered successfully launched.
There is no hard deadline — the pilot is launched when all items below are
checked, not when a calendar date arrives.

**Invitations**

- [ ] All intended pilot members have been invited. (Target number: confirm
      with operator before rollout — fill in here: ___ members invited.)
- [ ] No invite is outstanding for more than 7 days without the member having
      acknowledged it. Follow up with anyone who has not accepted before the
      7-day invite expiry.

**Onboarding**

- [ ] At least 80% of invited members have completed onboarding (accepted
      invite, confirmed email, completed `/welcome`, landed on `/calendar`).
- [ ] No member is stuck in an unresolved onboarding failure. Any failure that
      occurred has been root-caused and resolved (or the member has been
      re-invited).

**Core flows used by real members**

- [ ] At least 5 court bookings completed across the member group.
- [ ] At least 2 court cancellations completed (from Calendar or My Schedule).
- [ ] At least 1 event created by the admin and joined by at least 1 member.
- [ ] Notification bell used by at least 1 member; real-time update confirmed
      working in production at this scale.

**Data integrity**

- [ ] Zero instances of cross-club data exposure (North Shore Towers ↔
      Riverside, or any other club).
- [ ] All member profiles are correctly scoped to `north-shore-towers`.
- [ ] No duplicate participant, reservation, or notification rows for any member.
- [ ] `/admin/audit-log` shows no unexplained system-level errors.

**No unresolved pilot blockers**

- [ ] Every stop condition from Part 6 of Phase 21D was either not triggered,
      or was triggered, root-caused, and resolved.
- [ ] No new regressions introduced since Phase 20E-C or Phase 21X.
- [ ] No critical support issue (data exposure, booking failure, signup
      failure) is left open at the time of sign-off.

**Feedback categorized**

- [ ] Feedback collected from all members who responded.
- [ ] Every reported item classified as one of:
  - **Fix now** — blocking or significantly confusing; resolve before declaring
    pilot launched.
  - **Defer to post-pilot** — rough edge, cosmetic, or low-frequency; log to
    backlog.
  - **Training issue** — user confusion that can be addressed with a short
    explanation to this member; not a product bug.
- [ ] No feedback item left in an unknown state.

**Sign-off**

When all items above are checked, the pilot is launched. Update this section
header to **Status: Complete ✓** and record:

- Date pilot declared launched: ___
- Members invited: ___
- Members onboarded: ___
- Open issues at launch: ___ (or "none")

---

## Phase 21E-C — Account & Calendar Polish

**Status: Complete ✓ — pnpm tsc and pnpm build pass**

### Part A — Logged-in password change

**Goal:** Allow a logged-in user to change their password from the Profile area without requiring the forgot-password email flow.

**Files added**

| File | Description |
|---|---|
| `src/app/(app)/profile/security/page.tsx` | Server component — auth guard + renders `ChangePasswordForm` |
| `src/app/(app)/profile/security/ChangePasswordForm.tsx` | Client component — two password fields, validation, `updateUser` call, success/error state |

**Files changed**

| File | Change |
|---|---|
| `src/app/(app)/profile/page.tsx` | Added Security section (between Notifications and Help) with link to `/profile/security` |

**Implementation notes**

- Uses `supabase.auth.updateUser({ password })` on the browser client — the existing session cookie is sufficient proof of identity. No current password is required.
- No migration required — password validation is handled by Supabase Auth.
- Does not affect `/forgot-password`, `/reset-password`, or `/auth/confirm` flows.
- Fields clear on success. Success message auto-clears after 3 s.

**Known limitation: current password not required**

`updateUser({ password })` for a session-authenticated user does not require the current password. The active session proves identity. Supabase does not expose a simple reauthentication-before-change API without an OTP flow, which is disproportionate for a private club pilot. Flag as post-pilot hardening if needed.

**Deferred: email change**

`updateUser({ email })` triggers confirmation emails to both old and new addresses and requires PKCE confirmation. Deferred to a future profile polish phase.

**QA checklist**

Happy path:
- [ ] `/profile` shows a Security section with a "Change password" row and `›` chevron
- [ ] Tapping it navigates to `/profile/security` with Header title "Change Password"
- [ ] Page description: "Enter a new password for your account."
- [ ] Entering matching passwords ≥ 8 chars → button shows "Saving…" → "Password updated." (green, 3 s)
- [ ] Password fields clear after success
- [ ] Sign out → sign back in with new password → success
- [ ] Old password rejected after change

Validation (no API call):
- [ ] One field empty → "Please fill in both fields."
- [ ] Passwords don't match → "Passwords do not match."
- [ ] Password < 8 characters → "Password must be at least 8 characters."

Error handling:
- [ ] Supabase error → error message shown inline, form stays active
- [ ] Unauthenticated user hits `/profile/security` directly → redirects to `/sign-in`

Regression:
- [ ] `/forgot-password` flow unaffected
- [ ] `/reset-password` (token-based) unaffected
- [ ] `/profile` edit form (name/phone) saves correctly
- [ ] `/profile/notifications` navigates and saves correctly

---

### Part B — Calendar Select all / Deselect all

**Goal:** Replace the ambiguous `All` court filter button with a clearer two-state `Select all` / `Deselect all` control.

**File changed**

| File | Change |
|---|---|
| `src/app/(app)/calendar/CalendarShell.tsx` | Court filter "All" button replaced with `Select all` / `Deselect all` toggle |

**Filter model (unchanged)**

`selectedCourtIds` is a `Set<string>`. It starts with all court IDs. `filteredCourts` derives from this set. Individual court chips toggle membership; `toggleCourt` prevents deselecting the last court via individual chips. A placeholder column renders when the set is empty.

**Select all / Deselect all behavior**

| State | Button label | Click action |
|---|---|---|
| Not all courts selected | `Select all` | Sets `selectedCourtIds` to all courts |
| All courts selected | `Deselect all` | Sets `selectedCourtIds` to empty set |

- "All courts selected" is determined by `courts.length > 0 && selectedCourtIds.size === courts.length`.
- The button styling (accent when all selected, gray when not) is unchanged.
- No booking logic, court data fetching, or database schema changed.

**QA checklist — desktop and mobile**

- [ ] `/calendar` loads with all courts selected; button shows "Deselect all" (accent color)
- [ ] Clicking "Deselect all" clears all court columns; button switches to "Select all" (gray)
- [ ] Clicking "Select all" restores all courts; button switches back to "Deselect all" (accent color)
- [ ] Clicking an individual court chip from all-selected state deselects it; button switches to "Select all"
- [ ] Clicking "Select all" from a partial selection selects all courts
- [ ] Booking a court slot still works after selecting/deselecting courts
- [ ] Filter state does not persist across date changes (date change re-renders; filter state is in local React state, not URL)

---

## Phase 21E-D — Back Navigation Polish

**Status: Complete ✓ — pnpm tsc and pnpm build pass**

### Goal

Add a clear `← Back to Profile` link to all deep sub-pages so users (especially on mobile) are never left without an obvious return path.

### Context

There is no `/admin` landing page. All admin sub-pages are accessed via the Profile page (Admin section). The Profile tab exists in both the bottom nav (mobile) and the side nav (desktop), but sub-pages and admin pages don't have an explicit back affordance. This change adds a consistent link to the top of every affected page.

### Pages updated

| Page | Back link | Placement |
|---|---|---|
| `/profile/notifications` | `← Back to Profile` | Between Header and content |
| `/profile/security` | `← Back to Profile` | Between Header and content |
| `/admin/courts` | `← Back to Profile` | Between Header and content |
| `/admin/settings` | `← Back to Profile` | Between Header and content |
| `/admin/members` | `← Back to Profile` | Inside scroll container, top |
| `/admin/audit-log` | `← Back to Profile` | Inside scroll container, top |
| `/admin/events` | `← Back to Profile` | Inside scroll container, top |
| `/help` | `← Back to Profile` | Inside scroll container, top |

**Scroll-container pages** use `height: var(--page-fill-height)` to fill the viewport. Adding content outside these containers would break the height calculation, so the back link is placed as the first element inside the container.

### Pages intentionally unchanged

| Page | Reason |
|---|---|
| `/calendar` | Root nav tab — no parent to return to |
| `/events` | Root nav tab — no parent to return to |
| `/my-schedule` | Root nav tab — no parent to return to |
| `/profile` | Root nav tab — no parent to return to |
| `/book` | Immediately redirects to `/calendar` |

### QA checklist

- [ ] `/profile/notifications` — "← Back to Profile" link visible at top; tapping navigates to `/profile`
- [ ] `/profile/security` — "← Back to Profile" link visible at top; tapping navigates to `/profile`
- [ ] `/admin/courts` — "← Back to Profile" link visible at top; tapping navigates to `/profile`
- [ ] `/admin/settings` — "← Back to Profile" link visible at top; tapping navigates to `/profile`
- [ ] `/admin/members` — "← Back to Profile" link visible at top inside scroll area; tapping navigates to `/profile`
- [ ] `/admin/audit-log` — "← Back to Profile" link visible at top inside scroll area; tapping navigates to `/profile`
- [ ] `/admin/events` (admin) — "← Back to Profile" link visible at top inside scroll area; tapping navigates to `/profile`
- [ ] `/help` — "← Back to Profile" link visible at top inside scroll area; tapping navigates to `/profile`
- [ ] Desktop: back link renders cleanly below the Header, left-aligned within the page's max-width container
- [ ] Mobile: back link is reachable without scrolling on all above pages
- [ ] No regression: bottom nav and side nav still work correctly on all pages
- [ ] No regression: page content and scroll behavior unaffected on all pages

---

## North Shore Towers Pilot — Final Launch Checklist

**Status: Ready for execution**

Work through this top to bottom before inviting any members. Checkpoint 21E Parts 1–7 cover rollout logistics and monitoring in detail; this checklist is the sequential "do this now" execution flow. Do not skip steps or reorder them.

---

### Step 1 — Coordinator admin setup

Establish the coordinator as a second admin before any members are invited. This ensures the pilot can be managed independently without depending on the original admin for every action.

**A. Invite the coordinator**

- [ ] Sign in as the original admin at `https://court-time.vercel.app`
- [ ] Go to `/profile` → Admin → Members → **Invite**
- [ ] Set role to **admin**
- [ ] Enter the coordinator's verified email address in the email-restriction field
- [ ] Copy the `/join/<code>` URL
- [ ] Send the link to the coordinator directly with context ("You are being added as a club admin, not a regular member")

**B. Coordinator onboarding verification**

- [ ] Coordinator accepts the invite and completes `/welcome`
- [ ] Coordinator appears in `/admin/members` with role **admin** and status **active**
- [ ] Coordinator signs in and confirms their display name is correct on `/profile`
- [ ] Coordinator navigates to `/profile` and can reach all admin pages: Members, Courts, Settings, Audit Log, Events
- [ ] Coordinator can view the member list on `/admin/members`
- [ ] Coordinator creates a test event on `/admin/events` and confirms it appears on `/calendar`
- [ ] Coordinator deletes or cancels the test event after confirming
- [ ] Coordinator changes their temporary password: `/profile` → Security → Change password → confirms "Password updated."

**C. Backup admin confirmed**

- [ ] Original admin account remains active and retains the **admin** role
- [ ] Both admin accounts are visible in `/admin/members`
- [ ] Do not remove or downgrade the original admin at any point during the pilot

---

### Step 2 — Pre-member launch checks

Run all of these before sending any member invites. If any item fails, resolve it before proceeding to Step 3.

**Club configuration**

- [ ] `/admin/courts` — all active courts are visible, named correctly, and in the correct display order; no inactive courts are showing
- [ ] `/admin/settings` → Booking Rules — `booking_window_days` matches the intended advance window
- [ ] `/admin/settings` → Booking Rules — `cancellation_window_hours` matches the club's policy
- [ ] `/admin/settings` → Operating Hours — all days of the week are configured correctly; any closed dates or holidays are marked
- [ ] Club name appears correctly in the app Header for both admin accounts

**Email notifications**

- [ ] `RESEND_API_KEY` is present in Vercel → Project → Settings → Environment Variables (value must not be empty or a placeholder)
- [ ] Coordinator sends a test announcement via `/admin/settings` → Announcements; confirms the email arrives at their own address within 2 minutes
- [ ] Resend dashboard → Emails — the test announcement shows delivery status `delivered`

**SMS — confirmed deferred**

- [ ] `/profile` does not show a "Text Notifications" section — confirmed hidden
- [ ] No Twilio environment variables are active; no SMS will be sent to members

**Password change**

- [ ] `/profile` shows a Security section with a "Change password" link
- [ ] Coordinator has already changed their own password (Step 1B above)

**Back navigation**

- [ ] `/profile/notifications`, `/profile/security`, `/admin/members`, `/admin/courts`, `/admin/settings`, `/admin/audit-log`, `/admin/events`, `/help` all show "← Back to Profile" at the top

**Pilot hygiene**

- [ ] `/admin/members` — no test or dummy accounts remain active in North Shore Towers; any accounts created during development or smoke testing are removed or confirmed as real participants
- [ ] No Riverside invite links or Riverside credentials are accessible to any North Shore Towers participant
- [ ] Production URL confirmed: `https://court-time.vercel.app` loads without error on mobile and desktop

---

### Step 3 — First member wave

**Target:** 5–10 members. See Checkpoint 21E Part 2 for batching rationale.

**Who to invite first:** Members who are digitally comfortable, use courts regularly, and will give direct feedback. Avoid the most tech-averse members in the first wave — save them for wave 2 once the flows are validated with more confident users.

**Invite process:** Follow Checkpoint 21E Part 3. Role: **member** for all standard pilot members. Send the invite message from Checkpoint 21E Part 4.

**What members should do in their first session**

1. Accept the invite and create their account
2. Complete `/welcome`
3. Book a court reservation for a near-future date
4. Cancel that reservation from Calendar or My Schedule
5. Check the notification bell after each action
6. Browse `/events` to see posted events
7. Visit `/profile/security` → Change password → confirm it works

**Feedback to collect after each member's first 1–2 sessions**

1. Did you receive the signup confirmation email? Did it go to spam?
2. Was the invite → signup → calendar flow clear? Where did you hesitate?
3. Did you book a court successfully? If not, what happened?
4. Did you receive a booking confirmation email?
5. Did the notification bell update after booking or joining an event?
6. Was anything confusing, broken, or missing?
7. Did you change your password? Did it work?

Classify each response as: **fix now** / **defer to post-pilot** / **training issue** (user confusion, not a product bug).

---

### Step 4 — Support and monitoring

**When a member reports an issue, always request:**

- Exact page or action they were on (e.g., "I was booking a court on the calendar")
- What they expected and what happened instead
- A screenshot if possible
- Their device and browser (e.g., iPhone 15 / Safari, Android / Chrome)

**First 24 hours — check once per day**

- [ ] `/admin/members` — every invited member who has accepted shows **active** status; no one stuck on **pending** without explanation for more than 24 hours
- [ ] `/admin/audit-log` — scan for unexpected system errors or repeated failed actions
- [ ] Resend dashboard — no unexpected delivery failures for notification emails sent to members
- [ ] Vercel → Functions logs — no repeated 500 errors on booking, cancellation, or profile routes

**First 48 hours — extended checks**

All 24-hour items, plus:

- [ ] `/admin/events` — participant counts and event statuses are correct; no phantom participants
- [ ] At least one booking and one cancellation completed by a real member (visible in `/admin/audit-log`)
- [ ] At least one notification email delivered to a member (check Resend → Emails with a member's email address)
- [ ] Notification bell and panel: spot-check on mobile and desktop during an active member session
- [ ] First-wave feedback collected and classified (Step 3)

**Supabase areas to check if issues are reported**

- Authentication → Users: find accounts stuck in unconfirmed state (`email_confirmed_at` is null)
- Authentication → Logs: look for OTP exchange errors, invalid code errors, or rate-limit hits
- Database → Table Editor → `notification_deliveries`: check for unexpected `failed` rows

**Resend areas to check**

- Dashboard → Emails → filter by recipient email: confirm `delivered`
- `bounced` → email address has a typo; re-invite with the corrected address
- `failed` → check the error message; likely a configuration or domain issue

---

### Step 5 — Stop and pause conditions

**Stop immediately — do not invite additional members — if any of the following occur:**

| Condition | Action |
|---|---|
| Cross-club data exposure — any NST member sees Riverside data or vice versa | Stop all invites immediately. Do not investigate or fix speculatively. Escalate to the developer. No rollout resumes until the RLS exposure path is identified and confirmed closed. |
| Any member cannot sign up after following all triage steps (invite link failure, email not delivered, PKCE error) | Pause new invites until the root cause is confirmed fixed. |
| Any member cannot book a court after successful onboarding | Pause new invites. Check Vercel logs for `create_reservation` errors. Do not dismiss as user error without checking logs. |
| Coordinator loses admin access or cannot manage the pilot independently | Restore from the backup admin. Do not expand the member wave until coordinator access is confirmed restored. |
| A new unresolved data integrity issue appears in `/admin/audit-log` | Investigate before inviting more members. |

**Pause new invites (but do not stop existing members) if:**

- 3 or more members report the same confusing flow in the first wave — collect details before expanding
- A non-critical bug appears that measurably affects all users (e.g., booking confirmation not showing)
- Email notifications are failing consistently across multiple members — diagnose before expanding

**Email delivery failure is a soft-fail:** if emails are not delivering but all other flows work, the pilot can continue for existing members. Resolve before expanding to the next wave.

---

### Step 6 — Known pilot limitations

Do not promise these features to members during the pilot. They are confirmed deferred.

| Limitation | Details |
|---|---|
| SMS / text notifications | Deferred post-pilot. Twilio is not configured. The opt-in UI is hidden from `/profile`. No text messages will be sent. |
| Email change from profile | Not available in-app. Email addresses are set at invite time. If a member needs an email change, remove their account and re-invite with the correct address. |
| Current password not required when changing password | The active session proves identity. A member on an unlocked device could change the password without knowing the original. Acceptable for a private club pilot; post-pilot hardening if needed. |
| Multi-club account switching | Not implemented. Each account belongs to exactly one club. |
| Waitlist promotion mode toggle | Deferred. Currently using offer-confirm mode only: admin promotes members from the waitlist manually after a spot opens. |
| Coordinator cannot create courts | Courts are configured in `/admin/courts` by an admin. Coordinators can manage events, rosters, and members but court configuration requires the original admin. |

---

### Step 7 — Go/no-go decision

**All of the following must be checked before inviting any members:**

- [ ] Coordinator has completed Step 1 in full (admin access, test event, password changed)
- [ ] All Step 2 pre-member checks pass with no unresolved items
- [ ] Original admin account is active and confirmed as backup
- [ ] Email notifications confirmed working (test announcement delivered in Resend)
- [ ] No fake/test member accounts remain in North Shore Towers
- [ ] Production URL `https://court-time.vercel.app` is stable

**All of the following must be checked before expanding beyond the first wave:**

- [ ] All first-wave members have onboarded successfully — no stuck signups
- [ ] At least 3 members have completed at least one booking
- [ ] No unresolved stop conditions from Step 5
- [ ] First-wave feedback collected and classified — no item marked **fix now** is left open
- [ ] Coordinator has independently triaged at least one member support question
- [ ] 48-hour monitoring (Step 4) shows no unexpected system errors or delivery failures

**Sign-off**

When all go/no-go items above are checked, record:

- Date first members invited: ___
- Members in first wave: ___
- Members onboarded successfully: ___
- Date expanded to full group (if applicable): ___
- Open issues at expansion: ___ (or "none")

---

## Phase 21F — Pilot Hardening & Calendar Performance Polish

**Status: Complete ✓ — pnpm tsc and pnpm build pass**

### Scope

Low-risk improvements implemented while waiting for first-wave pilot feedback. No migrations. No booking/event/notification logic changed.

### Changes made

#### 1 — Calendar: event-by-court memoization

**File:** `src/app/(app)/calendar/CalendarShell.tsx`

Previously, the render loop ran `events.filter(ev => ev.court_ids.includes(court.id))` inside every court column on every render — scanning the full events array once per court. Added a `useMemo` (`eventsByCourtId`) that pre-indexes events into a `Map<courtId, EventWithDetails[]>` keyed by court. The render loop now does a single O(1) Map lookup per court column instead of O(events) filtering. The map rebuilds only when `events` changes.

No change to event fetching, refreshTick behavior, or booking logic.

#### 2 — Calendar: booking conflict message

**File:** `src/app/(app)/calendar/CalendarShell.tsx`

Changed the hardcoded conflict warning from:
> "Conflicts with an existing booking — try 60 min or a different slot."

To:
> "Conflicts with an existing booking. Try a shorter duration or a different slot."

The old message always said "try 60 min" regardless of the currently selected duration, which was confusing when the member was already on 60 min.

#### 3 — Help page: SMS section replaced with accurate Notifications section

**File:** `src/app/(app)/help/page.tsx`

Removed the "SMS Notifications" section that told members to opt in/out from Profile (the opt-in UI was hidden in Phase 21E-B). Replaced with a "Notifications" section with accurate pilot-ready copy:
- Email and in-app notifications are active
- Notification Preferences are in Profile
- SMS/text is not currently available

#### 4 — Help page: issue reporting guidance added to "Need Help?"

**File:** `src/app/(app)/help/page.tsx`

Added a third item to the "Need Help?" section:
> "When reporting an issue, include: what you were trying to do, which page you were on, what happened, and your device or browser if relevant. A screenshot is always helpful."

#### 5 — Admin members: invite copy failure made visible

**File:** `src/app/(app)/admin/members/MembersClient.tsx`

Previously, if browser clipboard access was denied, the "Copy Link" button failed silently. Now:
- On success: shows "Copied!" (unchanged)
- On failure: shows "Copy failed — select manually." for 3 seconds, then resets

Added `copyError` state alongside the existing `copiedCode` state.

#### 6 — Admin announcement: confirmation copy updated

**File:** `src/app/(app)/admin/settings/AnnouncementsSection.tsx`

The confirmation step (amber inline box) already existed. Updated the copy to explicitly state what happens when an announcement is sent:
> "All active members will receive an in-app notification. Members with announcement emails enabled will also receive an email. This cannot be undone."

Previously the confirmation only said "Send this announcement to all active members?" with no mention of email.

### Deferred items (not in this phase)

| Item | Reason deferred |
|---|---|
| SMS/Twilio activation | Not configured; opt-in UI intentionally hidden for pilot |
| Email change from profile | Requires PKCE flow; deferred post-pilot |
| Multi-club account switching | Not in scope |
| `fetchEvents` / `refreshTick` decoupling | Medium risk; needs usage data before changing |
| Offset → cursor-based pagination | Acceptable at pilot scale; low practical risk |
| Resend retry system | Pilot failures can be triaged in Resend dashboard manually |
| External embeddable calendar / lobby/TV display | Future post-pilot feature; not in scope for Phase 21 |
| Recurring events complexity | Post-pilot |
| Payments | Post-pilot |

### QA checklist

**Calendar event optimization**
- [ ] `/calendar` loads with all events displayed on the correct court columns
- [ ] Events still appear when filtering to a single court (Select/Deselect all works correctly)
- [ ] No console errors related to event rendering
- [ ] Creating a new event (admin/pro) still appears on the calendar after refresh

**Calendar conflict message**
- [ ] Tap an occupied slot, set duration to 60 min → conflict message does not say "try 60 min"
- [ ] Conflict message reads: "Conflicts with an existing booking. Try a shorter duration or a different slot."
- [ ] "Confirm Booking" button remains disabled while conflict flag is set

**Help page**
- [ ] `/help` shows "Notifications" section (not "SMS Notifications")
- [ ] Notifications section says SMS is not currently available
- [ ] Notifications section mentions Profile → Notification Preferences
- [ ] "Need Help?" section includes issue-reporting guidance
- [ ] All other sections (Booking Rules, Cancellation Policy) still appear correctly

**Invite copy failure**
- [ ] `/admin/members` → pending invite → Copy Link → success: shows "Copied!" for 2 s
- [ ] Simulate clipboard denial (DevTools → Permissions → Clipboard API → deny) → Copy Link → shows "Copy failed — select manually." for 3 s, then resets
- [ ] Both copiedCode and copyError reset independently without affecting each other

**Announcement confirmation**
- [ ] `/admin/settings` → Announcements → fill in subject and message → click "Send Announcement"
- [ ] Amber confirmation box appears with: "Send to all active members?" and the explanation about in-app + email + cannot be undone
- [ ] "Yes, send it" sends the announcement; success message appears
- [ ] "Cancel" dismisses confirmation; form values are preserved
- [ ] Empty subject or body keeps "Send Announcement" button disabled

---

## Phase 21G — Mobile Numeric Input Polish

**Status: Complete ✓ — pnpm tsc and pnpm build pass**

### Goal

Replace clunky `type="number"` inputs with native `<select>` controls where the field is bounded and small-range, so mobile users get a native picker instead of a numeric keyboard.

### Numeric inputs audited

| File | Field | Action | Reason |
|---|---|---|---|
| `CreateEventSheet.tsx` (Step 4) | Capacity (spots) | **Converted to `<select>`** | Bounded 1–50, small range, mobile usability complaint |
| `CreateEventSheet.tsx` (Step 2) | Custom duration (`inputMode="numeric"`) | Left unchanged | Freeform arbitrary value; existing pill buttons already handle common cases |
| `BookingRulesForm.tsx` | Booking window days (1–365) | Left unchanged | Range too wide for select; admin-only form; desktop primary use |
| `BookingRulesForm.tsx` | Cancellation window hours (0–168) | Left unchanged | Range too wide; admin-only |
| `BookingRulesForm.tsx` | Cancellation grace period minutes (0–60) | Left unchanged | Admin-only; arbitrary values useful |
| `BookingRulesForm.tsx` | Waitlist offer window hours (1–72) | Left unchanged | Range too wide; admin-only |

### What changed

**File:** `src/app/(app)/calendar/CreateEventSheet.tsx`

`type="number"` capacity input in Step 4 replaced with `<select>`.

**Before:** A plain number input requiring numeric keyboard entry on mobile. No max defined; `Math.max(1, ...)` guard in onChange.

**After:** A native `<select>` showing options 1–50 (dynamically expanded if `event_type.default_capacity` exceeds 50). Mobile users see a native picker wheel. Desktop users see a dropdown. No `Math.max` guard needed since only valid options are selectable.

**Option range:** 1–50. If the event type's `default_capacity` is above 50 (unusual for a tennis club), the select expands to include it: `Array.from({ length: Math.max(50, capacity) }, ...)`.

**Form submission:** Unchanged. `capacity` state is passed directly as `p_capacity` to the `createEvent` action — no FormData, no name attribute to change.

**Backend validation:** The `create_event` RPC takes `p_capacity int` with no explicit max CHECK constraint. The only enforced minimum is `NOT NULL`. The frontend `capacity < 1` submit guard is preserved.

**Default values:** Preserved. `setCapacity(type.default_capacity)` fires when a type is selected (line ~204); the select shows the event type's default pre-selected.

### Mobile QA checklist

- [ ] Admin/pro: tap `+ Event` on calendar → proceed to Step 4 → Capacity field shows a native picker (not a numeric keyboard) on mobile
- [ ] Capacity picker shows options 1 through at least 50
- [ ] Default value matches the event type's configured default capacity
- [ ] Changing capacity updates the event summary line below the select (e.g. "4 spots")
- [ ] Creating an event with capacity 1 works correctly
- [ ] Creating an event with capacity 10 works correctly (joins fill up at 10, 11th join hits waitlist)
- [ ] "Create Event" button remains disabled if capacity drops below 1 (edge case guard unchanged)

### Desktop QA checklist

- [ ] Capacity field renders as a clean dropdown on desktop
- [ ] Dropdown styling matches surrounding form elements (border, padding, font size, dark mode)
- [ ] Dark mode: select background matches the input style (`dark:bg-gray-700`)

### Regression checklist

- [ ] Step 4 summary line shows correct capacity count
- [ ] Event creation completes and event appears on calendar
- [ ] Custom duration (pill buttons + Custom text input) in Step 2 unaffected
- [ ] BookingRulesForm fields unaffected

---

## Phase 21G-B — Mobile Safari Input Zoom Fix

**Status: Complete ✓ — pnpm tsc and pnpm build pass**

### Problem

iOS Safari automatically zooms in when a focused form control (`<input>`, `<select>`, or `<textarea>`) has `font-size < 16px`. The app's standard Tailwind class `text-sm` is 14px (0.875rem), which triggers this zoom on virtually every form field in the app — sign-in, profile, event creation, admin settings, announcements, etc.

The fix must not disable user-initiated zoom (`user-scalable=no` is prohibited; it violates WCAG 1.4.4 and harms low-vision users).

### Approach

A single global CSS rule in `src/app/globals.css` sets a 16px floor on mobile (below the Tailwind `sm:` breakpoint of 640px). At `sm:` and above, no override is applied — Tailwind's `text-sm` classes continue to control sizing on desktop. This covers all form controls in the entire app without touching individual component files.

Checkboxes and radio buttons are excluded (`input:not([type="checkbox"]):not([type="radio"])`) — they have no text to resize.

The rule uses `max-width: 639px` (one pixel below Tailwind's `sm: 640px`) so it activates on exactly the same breakpoint boundary as `sm:` Tailwind classes.

### Files changed

| File | Change |
|---|---|
| `src/app/globals.css` | Added `@media (max-width: 639px)` rule setting `font-size: 16px` on `input`, `select`, `textarea` (excluding checkbox and radio) |

No migrations. No RLS changes. No RPC changes. No component-level edits.

### CSS added

```css
@media (max-width: 639px) {
  input:not([type="checkbox"]):not([type="radio"]),
  select,
  textarea {
    font-size: 16px;
  }
}
```

### What is NOT changed

- `user-scalable` is not changed. User-initiated pinch-to-zoom is fully preserved.
- Viewport meta tag is not touched.
- Desktop font sizes (`text-sm`, `text-xs`) are unchanged — this rule fires only below 640px.
- Component class lists are unchanged — no per-file edits were required.

### Mobile QA checklist

- [ ] Sign-in page: tap email field → page does NOT zoom in on iOS Safari
- [ ] Sign-in page: tap password field → page does NOT zoom in
- [ ] Profile → Notification Preferences: toggle labels do not trigger zoom (no inputs there)
- [ ] Profile → Change Password: tap "New password" field → no zoom
- [ ] Calendar → Create event (admin/pro): tap Title field (Step 2) → no zoom
- [ ] Calendar → Create event (admin/pro): open Capacity select (Step 4) → no zoom
- [ ] Admin → Settings → Announcements: tap Subject field → no zoom
- [ ] Admin → Settings → Announcements: tap Message textarea → no zoom
- [ ] Admin → Settings → Booking Rules: tap any numeric input → no zoom
- [ ] Pinch-to-zoom still works on all pages (user zoom not disabled)
- [ ] Sign-in form appearance looks correct (no oversized text at sm: and above)

### Regression checklist

- [ ] Desktop: all form fields display `text-sm` sizing (14px) as before — global rule does not apply above 639px
- [ ] Dark mode: no styling regressions on inputs/selects/textareas
- [ ] Custom duration text input in CreateEventSheet (Step 2) no longer zooms on mobile
- [ ] Booking rules admin form inputs no longer zoom on mobile


---

## Phase 21H-A — Visual Design Polish: Theme Toggle

**Status: Implemented — pending QA and commit**

Branch: `phase-21h-theme-visual-polish`

### Summary

Phase 21H-A adds a manual light/dark mode toggle and a controlled set of
low-risk visual polish improvements. No booking, event, waitlist, notification,
auth, or admin permission logic was changed. No migrations. No schema changes.
No new packages added.

---

### Dark mode toggle implementation

Tailwind's `darkMode` was changed from `"media"` (OS-only) to `"class"` (class-controlled).
All existing `dark:` classes throughout the app continue to work identically —
they now respond to the presence of the `dark` class on `<html>` instead of the
OS media query.

**Flash-of-wrong-theme prevention:**
A small synchronous inline `<script>` is injected in `<head>` before the first
paint. It reads `localStorage.getItem('court-time-theme')` and adds the `dark`
class to `<html>` immediately if: (a) the user has explicitly saved a preference
of `"dark"`, or (b) no preference is saved and the OS prefers dark. This
eliminates the flash on hard refresh without any external package.

**Hydration mismatch prevention:**
`suppressHydrationWarning` is added to `<html>`. React ignores class differences
on this element during hydration, avoiding the "class mismatch" warning caused by
the blocking script running before React can compare server/client output.

**Preference storage:**
`localStorage` key `court-time-theme` stores `"light"` or `"dark"` (or is absent
for "follow system"). This is a device-local UI preference — it is not stored in
Supabase or the user profile.

**Package used:** None. No `next-themes` or other library.

---

### ThemeToggle component

**File:** `src/components/ThemeToggle.tsx` (new)

- Client component (`"use client"`)
- Renders a `32×32` accessible button with sun (in dark mode) or moon (in light
  mode) SVG icon, toggling the `dark` class on `document.documentElement` and
  writing to `localStorage`
- Before mount (`useState(false)` → `useEffect` sets `true`): renders a
  same-size `<div aria-hidden>` placeholder to avoid React hydration diff
- `aria-label` is dynamic: `"Switch to dark mode"` / `"Switch to light mode"`
- Includes `focus-visible:ring-2 focus-visible:ring-accent` for keyboard
  navigation
- Hover: `hover:text-gray-700 dark:hover:text-gray-200`
- Motion: `motion-safe:transition-colors` only

**Placement:** Injected in `src/components/Header.tsx` immediately left of the
`<NotificationBell />`, grouped in a `flex items-center gap-0.5` wrapper. The
three-element header layout (logo | title | actions) is unchanged.

---

### Safe visual polish

| Component | Change |
|---|---|
| `SideNav.tsx` | Changed `transition-colors` → `motion-safe:transition-colors duration-150` on nav links |
| `BottomNav.tsx` | Added `motion-safe:transition-colors duration-150` to tab link items |
| `NotificationBell.tsx` | Added `hover:text-gray-700 dark:hover:text-gray-200`, `motion-safe:transition-colors`, `focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2`, `rounded` to the button |
| `profile/page.tsx` | Added `hover:bg-gray-50 dark:hover:bg-gray-700/50 motion-safe:transition-colors` to all 6 profile list link rows |
| `globals.css` | Added `@media (prefers-reduced-motion: reduce)` blanket rule suppressing all transitions/animations at the CSS level as a safety net |

---

### Reduced motion

Two layers of protection:

1. **Tailwind `motion-safe:` variant** — all new transition classes added in
   this phase use `motion-safe:transition-colors` instead of `transition-colors`.
   Users with `prefers-reduced-motion: reduce` never see these transitions.

2. **CSS-level blanket rule in `globals.css`** — sets `transition-duration:
   0.01ms !important` and `animation-duration: 0.01ms !important` for all
   elements when reduced motion is requested. Catches any transitions not using
   the Tailwind variant.

---

### Explicitly deferred

| Item | Reason |
|---|---|
| Calendar slot hover color (blue → accent tint) | `bg-accent/5` requires CSS variable in RGB triplet format; current `--accent` is hex. Non-trivial to change safely mid-pilot. Defer to calendar polish phase. |
| Sheet/modal entrance animations | Moderate risk on mobile Safari; not approved for this phase. |
| Focus ring sweep across form components | Would create large diff; limited to ThemeToggle and NotificationBell only per approved scope. |
| SideNav dark mode toggle placement | Only placed in Header; sidebar option deferred as it would require client-side SideNav refactor. |
| SVG chevron component for profile rows | Low user impact; defer to general component polish. |
| Page transition animations | Not approved for pilot phase. |
| FAB shadow/hover polish | Low priority; defer. |
| Calendar loading skeleton | Complex to geometry-match the timeline grid; defer. |

---

### Files changed

| File | What changed |
|---|---|
| `tailwind.config.ts` | `darkMode: "media"` → `"class"` |
| `src/app/layout.tsx` | Added `suppressHydrationWarning` on `<html>`, explicit `<head>` with blocking theme script |
| `src/components/ThemeToggle.tsx` | **New file** — sun/moon toggle component |
| `src/components/Header.tsx` | Added `<ThemeToggle />` in right-side action group |
| `src/components/SideNav.tsx` | `transition-colors` → `motion-safe:transition-colors duration-150` |
| `src/components/BottomNav.tsx` | Added `motion-safe:transition-colors duration-150` |
| `src/components/NotificationBell.tsx` | Added hover, focus-visible, and motion-safe transition to button |
| `src/app/(app)/profile/page.tsx` | Added hover + transition to all 6 list link rows |
| `src/app/globals.css` | Added reduced-motion blanket rule |

No new npm packages. No migrations. No schema changes. No RLS changes.

---

### QA checklist — Phase 21H-A

#### Theme toggle — behavior

- [ ] Toggle icon appears in the header to the left of the notification bell on all pages
- [ ] Toggle shows moon icon in light mode and sun icon in dark mode
- [ ] Clicking toggle immediately switches the entire app to dark/light without flash or layout shift
- [ ] Refreshing the page preserves the toggled mode (localStorage persisted)
- [ ] Opening a new tab reflects the saved preference
- [ ] Clearing `localStorage` and refreshing falls back to OS system preference
- [ ] Toggle `aria-label` is correct: "Switch to dark mode" in light, "Switch to light mode" in dark

#### Theme toggle — hydration and flash

- [ ] Hard refresh in Chrome/Safari/Firefox: no flash-of-wrong-theme in either light or dark saved state
- [ ] No React hydration warnings in browser console
- [ ] No "Prop className did not match" warnings

#### Theme toggle — all 5 club themes

Test by changing the club theme in Admin → Settings → Branding:

- [ ] Classic Gray: light and dark look correct with toggle
- [ ] Forest Green: light and dark look correct with toggle
- [ ] Clay Court: light and dark look correct with toggle
- [ ] Ocean Blue: light and dark look correct with toggle
- [ ] Royal Purple: light and dark look correct with toggle

#### Theme toggle — OS preference override

- [ ] OS set to dark + toggle explicitly set to light: app shows light mode
- [ ] OS set to light + toggle explicitly set to dark: app shows dark mode
- [ ] After clearing localStorage, OS preference takes over again

#### Navigation polish

- [ ] SideNav active link: `bg-gray-100 dark:bg-gray-800 text-accent` — unchanged
- [ ] SideNav link hover transitions at ~150ms smoothly
- [ ] BottomNav active tab: `border-t-2 border-accent text-accent` — unchanged
- [ ] BottomNav tab changes apply a brief color transition
- [ ] Notification bell has visible hover color change on mouse-over
- [ ] Notification bell has visible focus ring on keyboard Tab navigation

#### Profile page

- [ ] Tapping/hovering any list row shows a subtle background tint
- [ ] Touch targets are unchanged (rows are still full-width tappable)
- [ ] Active/visited state of links unchanged

#### Reduced motion

- [ ] With OS `prefers-reduced-motion: reduce` enabled: no transitions fire on
      nav hover, notification bell hover, or profile row hover
- [ ] With `prefers-reduced-motion: no-preference`: transitions fire normally

#### Accessibility

- [ ] ThemeToggle button is reachable by keyboard Tab and activatable with Enter/Space
- [ ] ThemeToggle focus ring is visible in both light and dark mode
- [ ] NotificationBell focus ring is visible in both light and dark mode
- [ ] No interactive element lost its focus indicator

#### Regression — core flows unchanged

- [ ] Court booking on `/calendar`: tap slot → booking sheet → confirm → slot shows "You"
- [ ] Event join on `/events`: join → Joined badge appears
- [ ] Notification bell: unread count increments in real time; sheet opens correctly
- [ ] Admin pages load without visual regression in both light and dark mode
- [ ] Calendar dark mode grid borders, date pills, and event blocks render correctly

#### Desktop layout

- [ ] Header: logo | title | [toggle][bell] layout correct; no crowding on narrow desktop
- [ ] SideNav visible; sidebar and content still properly offset by `md:pl-56`
- [ ] ThemeToggle and NotificationBell both visible at `768px` viewport width

#### Mobile layout

- [ ] Header elements fit within `h-14` at 375px (iPhone SE width)
- [ ] BottomNav visible; safe area insets respected
- [ ] ThemeToggle tap target is reachable (button is 32×32; well within reach zone)


---

## Phase 21H-A Refinement Note

**Status: Implemented — replaces initial Phase 21H-A implementation above**

Branch: `phase-21h-theme-visual-polish`

### Issues found in review and root causes

**Issue 1 — Profile dark background in light mode**

Root cause: `globals.css` defined `--accent` and `--surface` using
`@media (prefers-color-scheme: dark)`. After switching Tailwind to
`darkMode: "class"`, Tailwind's `dark:` utilities correctly follow the
`.dark` class on `<html>`, but `--surface` (used by `.app-main-content`
on every page) still followed the OS. When the user's OS preference and
manual toggle disagreed — e.g. OS dark + user toggled to light — `--surface`
stayed dark while all other backgrounds went light, producing a very dark
profile/content-area background in a light-mode session.

**Issue 2 — Navigation flicker**

Same root cause as issue 1. During page transitions, `.app-main-content`
briefly shows its `background-color: var(--surface)` while the loading
skeleton elements draw on top. When `--surface` was media-query-driven,
the color was inconsistent with the Tailwind dark: classes on the skeleton
elements, creating a visible flash. Secondary cause: `events/loading.tsx`
and `my-schedule/loading.tsx` had explicit `bg-gray-50 dark:bg-gray-900`
on their content wrapper instead of inheriting from `app-main-content`.
Five real-page scroll containers across `/events`, `/my-schedule`, and
three admin pages also hardcoded `bg-gray-50 dark:bg-gray-900`, overriding
`var(--surface)` and breaking the per-club theme surface on non-gray themes.

**Issue 3 — Toggle abrupt feel**

No `transition` was present on the key layout surfaces (body, header, sidebar,
bottom nav, page content area). Switching the `.dark` class caused all
backgrounds to snap instantly.

---

### Fixes applied

**`globals.css` — CSS variable selectors rewritten**

Replaced all `@media (prefers-color-scheme: dark)` overrides for `--accent`
and `--surface` with `.dark` and `.dark .theme-*` class selectors:

```css
/* Before (wrong — follows OS, not toggle) */
:root { --accent: #374151; --surface: #f4f5f6; }
@media (prefers-color-scheme: dark) {
  :root { --accent: #d1d5db; --surface: #11161f; }
}

/* After (correct — follows .dark class on <html>) */
:root { --accent: #374151; --surface: #f4f5f6; }
.dark { --accent: #d1d5db; --surface: #11161f; }
.theme-forest-green       { --accent: #15803d; --surface: #f0faf3; }
.dark .theme-forest-green { --accent: #4ade80; --surface: #0e1a13; }
/* … same pattern for clay-court, ocean-blue, royal-purple */
```

`.dark` specificity (0,1,0) — same as `:root` — wins via source order.
`.dark .theme-*` specificity (0,2,0) — wins over `.theme-*` (0,1,0). CSS
variables inherit, so the correct surface and accent cascade to all
descendants of the theme div.

**`globals.css` — `app-main-content` transition**

Added `transition: background-color 150ms ease-out` under
`@media (prefers-reduced-motion: no-preference)` so the page content area
transitions smoothly when the toggle fires (the background changes because
`var(--surface)` changes).

**`src/app/layout.tsx` — body and wrapper transition**

Added `motion-safe:transition-colors motion-safe:duration-150` to `<body>`
and the `min-h-screen` wrapper div.

**`src/components/Header.tsx` — header transition**

Added `motion-safe:transition-colors motion-safe:duration-150` to `<header>`.

**`src/components/SideNav.tsx` — sidebar transition**

Added `motion-safe:transition-colors motion-safe:duration-150` to `<nav>`.

**`src/components/BottomNav.tsx` — bottom nav transition**

Added `motion-safe:transition-colors motion-safe:duration-150` to `<nav>`.

**Background cleanup — 7 files**

Removed `bg-gray-50 dark:bg-gray-900` from scroll container wrappers in:
- `src/app/(app)/events/loading.tsx`
- `src/app/(app)/my-schedule/loading.tsx`
- `src/app/(app)/events/page.tsx`
- `src/app/(app)/my-schedule/page.tsx`
- `src/app/(app)/admin/audit-log/page.tsx`
- `src/app/(app)/admin/members/page.tsx`
- `src/app/(app)/admin/events/page.tsx`

These elements all live inside `<main class="app-main-content">` which
provides `background-color: var(--surface)`. The explicit override was
incorrect: it used a flat gray regardless of club theme, and it ignored
the manual dark mode toggle (contributing to flicker).

---

### Known remaining limitations

- The calendar's open-slot hover uses `hover:bg-blue-50 dark:hover:bg-blue-900/20`
  (hardcoded blue, not accent tint). This is a pre-Phase 21H limitation deferred
  because `bg-accent/5` requires the CSS variable to be a space-separated RGB
  triplet, not hex. Defer to a dedicated calendar polish phase.
- The `/calendar` loading skeleton is not themed to `var(--surface)` (it uses
  `bg-white dark:bg-gray-900` for the grid background, which is intentional for
  calendar rendering).
- On first server-render (before hydration), ThemeToggle shows a same-size `<div>`
  placeholder. It snaps to the correct icon immediately on hydration. No layout
  shift because the placeholder dimensions match the button.

---

### Additional QA items for the refinement

- [ ] `/profile` background in light mode matches the rest of the app (no dark gutter)
- [ ] `/profile` background in dark mode is correct (dark surface, white cards)
- [ ] OS dark + manual toggle to light → profile, events, my-schedule, admin pages all show light surface
- [ ] OS light + manual toggle to dark → all pages show dark surface
- [ ] `/events`, `/my-schedule`, `/admin/members`, `/admin/events`, `/admin/audit-log` surfaces now match `var(--surface)` for all 5 club themes
- [ ] Theme toggle: header, sidebar, bottom nav, and page content all transition in 150ms — no snapping
- [ ] Navigation between `/events` and `/my-schedule` no longer flickers gray-50 before the real page loads
- [ ] `prefers-reduced-motion: reduce` — toggle is instant (no transition), `animate-pulse` skeletons stop
- [ ] No new console warnings or errors

---

## Phase 21H-B — Visible Polish Layer

**Status: Complete ✓ — pnpm tsc --noEmit passes; pnpm build passes**

### What was changed

A clearly visible but pilot-safe polish layer applied on top of the 21H-A
theme toggle and surface fixes. No layout changes, no new packages, no
migrations, no logic changes.

**Components (visible on every page):**
- `ThemeToggle.tsx` — hover background fill (`bg-gray-100 / dark:bg-gray-800`),
  active-press background, `rounded-lg`, `motion-safe:transition-all`
- `NotificationBell.tsx` — same hover/active fill treatment as ThemeToggle
- `SideNav.tsx` — inactive nav links gain `active:bg-gray-200 dark:active:bg-gray-700`
  pressed state; `transition-colors` → `transition-all`
- `BottomNav.tsx` — inactive tabs gain `active:opacity-60` pressed feel;
  `transition-colors` → `transition-all`

**Profile page:**
- `profile/page.tsx` — all list-row links gain `active:bg-gray-100 dark:active:bg-gray-700/70`
  and `motion-safe:duration-100` for snappier tap feedback
- `SignOutButton.tsx` — `active:scale-[0.98]`, `active:bg-gray-100 dark:active:bg-gray-700`,
  `motion-safe:transition-all`

**Forms:**
- `ProfileEditForm.tsx` — inputs: `focus:ring-2 focus:ring-accent` (was ring-1 + gray);
  Save button: `shadow-sm`, `hover:brightness-110`, `active:scale-[0.97]`,
  `motion-safe:transition-all`, `disabled:cursor-not-allowed`
- `BookingRulesForm.tsx` — same input focus ring and button improvements

**Cards:**
- `events/page.tsx` — event cards get `shadow-sm` for elevation;
  all inline action buttons (Join, Leave, Accept, Pass, Rejoin) get
  `hover:opacity-75 active:scale-95 motion-safe:transition-all motion-safe:duration-100`
- `my-schedule/page.tsx` — reservation and event cards get `shadow-sm`;
  Cancel and Leave/Leave Waitlist buttons get same hover/active treatment as above

**Auth:**
- `sign-in/SignInForm.tsx` — Sign in button: `shadow-sm`, `hover:brightness-110`,
  `active:scale-[0.98]`, `motion-safe:transition-all`, `disabled:cursor-not-allowed`

### Design principles applied

- All transitions: `motion-safe:transition-all motion-safe:duration-150` (or 100ms for
  quick-tap inline buttons)
- Active/pressed states use `active:scale-[0.97–0.98]` on solid buttons,
  `active:opacity-60` on nav tabs, `active:bg-*` fill on icon buttons and rows
- `hover:brightness-110` on solid-color buttons (works with CSS variable --accent)
- `shadow-sm` on content cards for visual elevation in light mode
- `focus:ring-2 focus:ring-accent` on form inputs (was ring-1 + hardcoded gray)
- `prefers-reduced-motion: reduce` blanket rule in globals.css still suppresses all

### QA checklist — Phase 21H-B (first attempt — marked SUPERSEDED)

> **Note:** This first attempt was too subtle. `active:` states only show while pressing,
> `shadow-sm` was invisible in practice, `hover:opacity-75` felt flat. All superseded by
> the Phase 21H-B Refinement below.

---

## Phase 21H-B Refinement — Clearly Visible Polish

**Status: Complete ✓ — pnpm tsc --noEmit passes; pnpm build passes**

### Root cause of the original attempt being too subtle

- `active:` pseudo-class only fires while finger/mouse is depressed — invisible in normal desktop hover
- `shadow-sm` is a 1px shadow at 5% opacity — barely distinguishable in practice
- `hover:opacity-75` on inline buttons just fades them — not a premium feeling
- No hover states on sidebar nav meant desktop felt completely static
- Focus rings only visible during keyboard navigation, not mouse/touch

### What changed in the refinement

**New global CSS utility classes in `globals.css`:**

- `.ct-button-primary` — accent button with real CSS `filter: brightness(1.1)` hover,
  `box-shadow` lift on hover (`0 4px 6px -1px rgb(0 0 0 / 0.14)`), `scale(0.97)` on press,
  and `outline: 2px solid var(--accent)` focus-visible. Transition via CSS
  `@media (prefers-reduced-motion: no-preference)`, not Tailwind utility chains.
- `.ct-input` — form control with `border-color: var(--accent)` + `box-shadow: 0 0 0 1px var(--accent)`
  on focus. Smooth `border-color 150ms ease-out, box-shadow 150ms ease-out` transition.
- `.ct-card` — content card with `box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.07)` (2× shadow-sm)
  and proper dark-mode surface. Dark mode gets stronger border, no shadow.
- `.ct-row-interactive` — list row with hover background AND an `inset 3px 0 0 var(--accent)`
  left stripe that appears on hover — clearly visible in any theme color.

**SideNav (most impactful desktop change):**
- Inactive links: `hover:text-accent` — icon + text snap to accent color on hover.
  Previously `hover:text-gray-900` (barely visible). Now the hovered item matches the
  active item color, making the interaction feel intentional.
- Active links: added `font-semibold` for slightly stronger visual weight.

**BottomNav:**
- Inactive tabs: `active:text-accent` — color snaps to accent on tap press.
  More satisfying than `active:opacity-60`.

**Profile page rows:**
- All 6+ clickable Link rows replaced with `ct-row-interactive` — provides both
  hover background change AND accent left stripe on hover/active.

**Forms — primary buttons:**
- `ProfileEditForm.tsx`, `BookingRulesForm.tsx`, `ClubBrandingSection.tsx`,
  `AnnouncementsSection.tsx`, `ChangePasswordForm.tsx`: all accent buttons
  now use `ct-button-primary` — real hover lift + shadow, not just opacity.

**Forms — inputs:**
- `ProfileEditForm.tsx`, `BookingRulesForm.tsx`, `ClubBrandingSection.tsx`,
  `AnnouncementsSection.tsx`, `ChangePasswordForm.tsx`, `MembersClient.tsx`,
  `sign-in/SignInForm.tsx`: all use `ct-input` — accent border + ring on focus.
- `OperatingHoursEditor.tsx`, `DateOverridesEditor.tsx` (narrow time inputs):
  `focus:ring-2 focus:ring-accent focus:border-accent` (keeping original sizing).

**Sign-in page:**
- Inputs: `ct-input` (accent focus ring).
- Button: `ct-button-primary w-full` — full-width with hover lift. On sign-in page
  `--accent` resolves to `:root` default (`#374151` dark gray in light,
  `#d1d5db` light gray in dark) — still looks correct.

**Cards:**
- `events/page.tsx` event cards: `ct-card px-4 py-3` — better shadow, proper dark surface.
- `my-schedule/page.tsx` reservation + event cards: `ct-card mx-4 mb-3 px-4 py-3 ...`.
- `admin/members/MembersClient.tsx` member cards: `ct-card mx-4 mb-3` — consistent.

**Sign Out button:**
- Visible `hover:border-gray-400 hover:text-gray-800` state — border darkens and text
  gets darker on hover. `active:scale-[0.98]` press scale.

### Hover interactions now visible in normal use

| Element | Before | After |
|---|---|---|
| SideNav inactive link | Gray text → slightly darker gray | Gray → **accent color** (very visible) |
| SideNav active link | `text-accent bg-gray-100` | Same + `font-semibold` |
| BottomNav inactive | dims on press only | Snaps to accent color on press |
| Profile rows | Light gray fill on hover | Light fill + **accent left stripe** |
| Primary buttons | Brightness + scale (Tailwind) | **Shadow lift + brightness** (CSS, reliable) |
| Form inputs | Gray ring on focus | **Accent border + accent ring** on focus |
| Cards | `shadow-sm` | `shadow-sm` equivalent + **darker in light, bordered in dark** |

### Known limitations (unchanged from 21H-A)

- ThemeToggle placeholder div before hydration (intentional, prevents layout shift)
- Calendar own-reservation block still uses blue (`border-2 border-blue-500 bg-blue-50`) —
  intentional design choice (blue = your booking); safe to leave.

---

## Phase 21H-B Header Alignment — Consistent Interaction System

**Status: Complete ✓ — pnpm tsc --noEmit passes; pnpm build passes**

### Problem

Header controls (ThemeToggle, NotificationBell) had a different hover behavior from the
sidebar: they changed from gray-500 → gray-700 on hover (barely visible) with no accent
color. After the sidebar polish, the controls felt like they belonged to a different app.

### What changed

**New global CSS utility classes in `globals.css`:**

- `.ct-icon-button` — icon button (w-8 × h-8, rounded-lg) with:
  - Hover: `bg-gray-100 / dark:bg-gray-800` fill + `color: var(--accent)` (matches sidebar)
  - Active: darker fill + accent color + `scale(0.9)` press
  - Focus-visible: `outline: 2px solid var(--accent); outline-offset: 2px`
  - `transition: background-color, color, transform 150ms ease-out`
  - Same accent-color hover as the sidebar — all header controls now feel unified

- `.ct-button-secondary` — composable bordered button (no hardcoded padding):
  - Resting: neutral border + gray text
  - Hover: `border-color: var(--accent)` + `color: var(--accent)` + subtle bg fill
  - Active: `scale(0.97)` press
  - Composable — pair with Tailwind `px-*` `py-*` `text-*` classes for sizing

**ThemeToggle.tsx:**
- Replaced 12-class inline string with `className="ct-icon-button"`
- Hover now snaps to accent color (same as sidebar nav links)
- Press scales down to 0.9 for tactile feel

**NotificationBell.tsx:**
- Same: replaced with `ct-icon-button`
- Bell icon + badge now change to accent color on hover

**CalendarShell.tsx — safe slot hover fix:**
- Open slot hover: `hover:bg-blue-50 dark:hover:bg-blue-900/20` →
  `hover:bg-gray-100 dark:hover:bg-gray-700/25`
- Active slot: `active:bg-blue-100 dark:active:bg-blue-900/30` →
  `active:bg-gray-200 dark:active:bg-gray-700/40`
- The blue was hardcoded and theme-inconsistent; gray is neutral for all 5 themes
- Booking logic, event positioning, and RPC calls: unchanged

**Back-to-profile navigation links (8 files):**
- All `← Back to Profile` links: `hover:text-gray-700 dark:hover:text-gray-300` →
  `hover:text-accent motion-safe:transition-colors`
- Files: admin/settings, admin/courts, admin/audit-log, admin/events, admin/members,
  profile/security, profile/notifications, help
- Consistent with the sidebar's `hover:text-accent` treatment

**help/page.tsx:**
- Section cards use `ct-card` — proper shadow + dark surface

**admin/members/MembersClient.tsx:**
- `+ Invite` button: `hover:border-accent hover:text-accent` with transition
- Confirm dialog Cancel button: `hover:border-accent hover:text-accent` with transition

### Unified hover interaction system

| Control | Hover behavior |
|---|---|
| SideNav inactive link | Gray → **accent color** |
| SideNav active link | **accent color** (always) + bg fill |
| ThemeToggle | Gray icon → **accent icon** + bg fill |
| NotificationBell | Gray icon → **accent icon** + bg fill |
| BottomNav inactive | Snaps to **accent color** on press |
| Profile rows | Gray fill + **accent left stripe** |
| Back-nav links | Gray → **accent color** |
| Secondary buttons | Border → **accent border** + accent text |
| Primary buttons | Lifts (shadow) + brightens |
| Form inputs | Border + ring → **accent color** |

All accent-color hover effects use `var(--accent)` so they adapt to each club's theme.

### QA checklist — Phase 21H-B Header Alignment

**Header controls:**
- [ ] ThemeToggle: icon turns accent color on hover (same as sidebar links)
- [ ] ThemeToggle: background fills on hover (gray-100 / gray-800)
- [ ] ThemeToggle: scales down on press (0.9×)
- [ ] ThemeToggle: accent outline on keyboard focus
- [ ] NotificationBell: same hover/press/focus treatment
- [ ] NotificationBell badge still displays correctly (no layout shift)
- [ ] ThemeToggle placeholder div matches button dimensions (no layout shift)

**Navigation consistency:**
- [ ] SideNav + header icons feel like the same interaction system
- [ ] All `← Back to Profile` links turn accent color on hover
- [ ] Back-nav color transition is smooth (150ms)

**Calendar slot hover:**
- [ ] Open slots show gray hover tint (no longer blue)
- [ ] Calendar booking flow works end-to-end (hover → tap → booking sheet → confirm)
- [ ] Own reservation blocks still show blue border/fill (intentional, not changed)

**Help page:**
- [ ] Section cards have shadow in light mode (ct-card)
- [ ] Section cards show dark surface in dark mode

**Admin members:**
- [ ] `+ Invite` button shows accent border + text on hover
- [ ] Confirm dialog cancel button shows accent border + text on hover

**Reduced motion:**
- [ ] `ct-icon-button` scale + transition suppressed under reduced motion

**No regressions:**
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓ (pre-existing /sign-up cookies warning only)
- [ ] Theme toggle still works (dark/light toggle, localStorage, no FOUC)
- [ ] Booking logic unchanged
- [ ] Event/waitlist logic unchanged
- [ ] Admin permissions unchanged

### QA checklist — Phase 21H-B Refinement

**Desktop hover (primary test):**
- [ ] SideNav inactive link: text + icon turn accent color on hover (clearly visible)
- [ ] SideNav active link: font-semibold weight noticeable
- [ ] Profile rows show light gray fill + accent left stripe on hover
- [ ] Profile rows retain stripe during active press
- [ ] Sign Out border darkens, text darkens on hover

**Buttons:**
- [ ] Save / Send / Submit buttons: shadow lifts and brightens on hover (light mode)
- [ ] Buttons scale down (0.97) on press, shadow drops back
- [ ] Disabled buttons: opacity 40%, cursor not-allowed
- [ ] Focus-visible ring (2px solid accent) visible via keyboard navigation

**Form inputs:**
- [ ] Inputs show accent-colored border + thin ring on focus
- [ ] Transition is smooth (150ms) not instantaneous
- [ ] Mobile Safari zoom prevention still works (iOS, text inputs stay at 16px)

**Cards:**
- [ ] Event cards (events page) have visible shadow in light mode
- [ ] Schedule cards (my-schedule) have visible shadow in light mode
- [ ] Member cards (admin members) have visible shadow in light mode
- [ ] Dark mode: cards have border only (no shadow), surface correct

**Mobile tap (secondary test):**
- [ ] BottomNav tabs snap to accent color on tap (not just dim)
- [ ] Profile rows show accent stripe on tap
- [ ] Buttons show scale + shadow changes on tap

**Dark mode:**
- [ ] SideNav `hover:text-accent` visible in dark mode (uses dark-mode accent colors)
- [ ] Profile row accent stripe uses correct dark-mode accent
- [ ] ct-button-primary uses dark text (`color: rgb(17 24 39)`) on light accent backgrounds
- [ ] ct-card dark surface + border correct (gray-800 bg, gray-700 border)

**Theme consistency:**
- [ ] forest-green theme: sidebar hover turns green, rows show green stripe
- [ ] classic-gray theme: sidebar hover turns gray, rows show gray stripe
- [ ] ocean-blue theme: sidebar hover turns blue, rows show blue stripe

**Reduced motion:**
- [ ] `prefers-reduced-motion: reduce`: all transitions suppressed; `ct-button-primary`
  hover/active animations suppressed; `ct-input` transition suppressed
- [ ] Interactions still functional, just instant

**No regressions:**
- [ ] Calendar still works (layout, booking)
- [ ] Event join/leave/accept/pass still works
- [ ] Waitlist offer flow still works
- [ ] Admin member management still works
- [ ] No new console errors
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓ (pre-existing /sign-up cookies warning only)

---

## Phase 21H-C — Button, Card, Row, Form-Flow Interaction Polish

**Status: Complete ✓ — pnpm tsc --noEmit passes; pnpm build passes**

### Problem

Header/nav now felt polished but buttons, clickable cards, and creation forms still felt
static. Specific issues: `+ Block` / `+ Event` FABs didn't respond on hover; Create Event /
Block Court sheets used `focus:ring-gray-900` instead of the accent color; card hover states
were not connected to the interaction system; action buttons used `hover:opacity-75` which
affected the whole element and looked dull.

### New global CSS utility classes added

**`.ct-card-interactive`** — card surface that lifts 1px on hover with accent border:
- Hover: `border-color: var(--accent)`, `box-shadow` lift, `transform: translateY(-1px)`
- Active: `transform: translateY(0)` reset
- Focus-visible: `outline: 2px solid var(--accent)`
- 150ms `ease-out` transitions for border, shadow, transform

**`.ct-button-danger`** — red destructive button with clear hover shift:
- Resting: `bg-red-50 border-red-200 text-red-600` (dark: tinted red-900)
- Hover: `bg-red-100 border-red-500 text-red-700`
- Active: `scale(0.97)` press
- Focus-visible: `outline: 2px solid rgb(239 68 68)`

**`.ct-button-ghost`** — no border, subtle fill on hover:
- Resting: transparent bg, `text-gray-600`
- Hover: `bg-gray-100 text-gray-900` (dark: `bg-gray-700 text-gray-100`)
- Active: `scale(0.97)` press
- Focus-visible: `outline: 2px solid var(--accent)`

**`.ct-button-primary` updated:**
- Hover now includes `transform: translateY(-2px)` (slight float) in addition to the
  existing `filter: brightness(1.1)` and shadow lift
- Active: `scale(0.97) translateY(0)` — resets the float on press for tactile feel

### Calendar — `+ Block` and `+ Event` FAB buttons

Before: `px-4 py-2 rounded-full bg-accent ... shadow-md` (no motion states)

After: added `hover:shadow-lg active:scale-[0.97] motion-safe:hover:-translate-y-0.5
motion-safe:transition-all motion-safe:duration-150`

Effect on desktop hover: button floats up 2px, shadow deepens. On click: scales to 0.97×
with no delay. Shape (rounded-full) and colors unchanged.

### Calendar — slot action sheet buttons (Book Court / Create Event / Maintenance Block)

"Book Court" (accent fill): added `hover:brightness-110 active:scale-[0.98]
motion-safe:transition-all motion-safe:duration-150`

"Create Event" / "Maintenance Block" (secondary border): added `hover:border-accent
hover:text-accent active:scale-[0.98] motion-safe:transition-all motion-safe:duration-150`

No navigation, action, or booking logic changed.

### CreateEventSheet — form flow polish

**Focus rings:** all `focus:ring-gray-900` → `focus:ring-accent focus:border-accent`
(affects title input, start time select, custom duration input, capacity select)

**Event type cards (step 1):** added `hover:border-accent hover:bg-gray-50
dark:hover:bg-gray-600/60 active:bg-gray-100 motion-safe:transition-all`

**Back button:** added `hover:text-accent motion-safe:transition-colors`

**Duration / Custom pills:** inactive pills get `hover:border-accent hover:text-accent`;
added `active:scale-95` to all pill buttons

**Court pills (step 3):** inactive get `hover:border-accent hover:text-accent`;
added `active:scale-95`

**Continue / Create Event buttons:** added `hover:brightness-110
motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-md active:scale-[0.98]
motion-safe:active:translate-y-0 motion-safe:transition-all motion-safe:duration-150`

No form field names, submitted values, validation rules, or server actions changed.

### CreateMaintenanceSheet — form flow polish

**Focus rings:** all `focus:ring-gray-900` → `focus:ring-accent focus:border-accent`
(start time, end time selects; notes input)

**Pre-existing bug fixed:** start/end time selects had duplicate `dark:bg-gray-700` class
(pre-existing before this phase); cleaned up.

**Court pills:** inactive get `hover:border-accent hover:text-accent`; added `active:scale-95`

**Block Court(s) submit button:** added `hover:brightness-110 motion-safe:hover:-translate-y-0.5
motion-safe:hover:shadow-md active:scale-[0.98] motion-safe:active:translate-y-0
motion-safe:transition-all motion-safe:duration-150`

No form behavior, server actions, or block logic changed.

### Events page (`/events`)

**Cards:** upgraded from `ct-card` to `ct-card-interactive` — event cards now lift 1px with
accent border on hover

**Action buttons:** replaced `hover:opacity-75` (which fades the whole element) with semantic
hover color shifts:
- Join / Join Waitlist / Rejoin (blue): `hover:text-blue-800 dark:hover:text-blue-400`
- Leave / Leave Waitlist (red): `hover:text-red-700 dark:hover:text-red-400`
- Accept (green): `hover:text-green-800 dark:hover:text-green-400`
- Pass (gray): `hover:text-gray-700 dark:hover:text-gray-200`

### My Schedule page (`/my-schedule`)

**Cancel / Leave buttons:** replaced `hover:opacity-75` with
`hover:text-red-700 dark:hover:text-red-400`

### Admin Events (`/admin/events`)

**Cards:** migrated from inline `bg-white dark:bg-gray-800 rounded-xl border ...` to `ct-card`
(adds consistent shadow, border-radius, dark-mode surface)

**Load More button:** migrated to `ct-button-secondary px-4 py-2 text-sm` (gets accent hover,
border transition, active scale from the CSS class)

### Admin Courts (`/admin/courts`) — CourtManagementList

**Delete confirm button:** added `hover:bg-red-700 active:scale-95 motion-safe:transition-all`

**Rename input:** focus ring upgraded from `focus:ring-gray-400` to `focus:ring-accent
focus:border-accent`

**Rename Save / Cancel buttons:** Save gets `hover:text-green-800 dark:hover:text-green-300`;
Cancel gets `hover:text-gray-700 dark:hover:text-gray-200`

**Move ↑ / ↓ buttons, Rename button:** `hover:text-gray-700/300` → `hover:text-accent`

### Unified button system summary

| Class | Shape | Hover | Active |
|---|---|---|---|
| `.ct-button-primary` | Accent fill, `rounded-lg` | brightness + shadow lift + float up | scale 0.97, float reset |
| `.ct-button-secondary` | Border, `rounded-lg` | accent border + accent text | scale 0.97 |
| `.ct-button-danger` | Red-50/border, `rounded-lg` | red-100/border-red-500/text-red-700 | scale 0.97 |
| `.ct-button-ghost` | Transparent, `rounded-lg` | gray-100 fill + dark text | scale 0.97 |
| `.ct-icon-button` | Transparent, `rounded-lg`, 2rem | gray fill + accent icon | scale 0.9 |
| FAB (`+ Block`/`+ Event`) | Accent fill, `rounded-full` | shadow-lg + float up | scale 0.97 |

### QA checklist — Phase 21H-C

**Calendar FAB buttons:**
- [ ] `+ Event` button floats up 2px on hover (desktop)
- [ ] `+ Block` button floats up 2px on hover (desktop)
- [ ] Both scale to 0.97× on click (no delay, no bounce)
- [ ] Shadow grows on hover, returns on release
- [ ] Booking/event/block creation still opens correctly

**Calendar slot action sheet:**
- [ ] "Book Court" brightens on hover; scales on press
- [ ] "Create Event" border + text turns accent on hover; scales on press
- [ ] "Maintenance Block" same treatment
- [ ] All three still trigger the correct action

**CreateEventSheet form flow:**
- [ ] Focus ring on all inputs is accent-colored (not gray)
- [ ] Step 1 event type cards show accent border on hover
- [ ] ← Back button turns accent on hover
- [ ] Duration pills (30/45/60/90/120/Custom) show accent border + text on hover
- [ ] Court pills show accent border + text on hover (active/selected stay accent-filled)
- [ ] Continue button floats + brightens on hover; presses on click
- [ ] Disabled Continue (empty title) stays faded, no hover effect
- [ ] Create Event button same hover/press as Continue

**CreateMaintenanceSheet form flow:**
- [ ] Focus ring on selects and notes input is accent-colored
- [ ] Court pills show accent border + text on hover
- [ ] Block Court(s) button floats + brightens on hover; presses on click
- [ ] Disabled Block (no courts selected) stays faded, no hover effect

**Events page cards:**
- [ ] Event cards lift 1px on hover with accent border
- [ ] Join button darkens on hover (blue → blue-800)
- [ ] Leave button darkens on hover (red-500 → red-700)
- [ ] Accept button darkens on hover (green-600 → green-800)
- [ ] Pass button darkens on hover (gray-500 → gray-700)
- [ ] Rejoin button darkens on hover

**My Schedule page:**
- [ ] Cancel booking button darkens on hover (red-500 → red-700)
- [ ] Leave Event / Leave Waitlist button darkens on hover

**Admin Events page:**
- [ ] Event cards use ct-card surface (shadow, rounded-xl)
- [ ] Load More button shows accent border + text on hover

**Admin Courts page:**
- [ ] ↑ / ↓ move buttons turn accent on hover
- [ ] Rename button turns accent on hover
- [ ] Delete confirm (red bg) darkens on hover
- [ ] Rename input has accent focus ring
- [ ] Rename Save turns green-800 on hover; Cancel turns gray-700

**Reduced motion:**
- [ ] All `motion-safe:hover:-translate-y-0.5` suppressed under reduced motion
- [ ] `ct-button-primary` float suppressed under reduced motion
- [ ] `ct-card-interactive` lift suppressed under reduced motion

**No regressions:**
- [ ] Header/nav unchanged (no new classes on SideNav, BottomNav, ThemeToggle, NotificationBell)
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓
- [ ] Calendar booking flow end-to-end unchanged
- [ ] Event creation flow end-to-end unchanged
- [ ] Block court flow end-to-end unchanged
- [ ] Event join/leave/waitlist unchanged
- [ ] Admin permission checks unchanged

---

## Phase 21H-D — Overlay and Sheet Motion Polish

**Status: Complete ✓ — pnpm tsc --noEmit passes; pnpm build passes**

### Summary

Phase 21H-D adds entrance animations to all bottom sheet surfaces and the desktop
notification popover, polishes notification row hover states, and standardizes the
handlebar pill across all sheets.

No exit animations were added — components unmount immediately, and exit animations
require retained-mount or portal patterns that add non-trivial complexity. Entrance-only
is sufficient for the premium feel requested.

True drag-to-close was intentionally NOT added to the non-BottomSheet surfaces. The
`BottomSheet` component already has full touch + pointer drag-to-close (prior to this
phase), and those surfaces were left untouched.

### New global CSS utility classes

**`@keyframes ct-sheet-enter-keyframes`**:
`translateY(16px) + opacity:0` → `translateY(0) + opacity:1`

**`.ct-sheet-enter`**: 180ms `ease-out` entrance animation (`fill-mode: both`).
Wrapped in `@media (prefers-reduced-motion: no-preference)` — reduced-motion users see
the sheet appear instantly. The existing globals.css blanket rule (`animation-duration:
0.01ms`) would also suppress it, making the guard doubly safe.

**Safety with BottomSheet drag**: `BottomSheet` uses direct DOM `style.transform` mutations
during gestures. Inline styles always win over animation fills in the CSS cascade, so the
drag logic (`setPos()`) cleanly overrides the entrance animation during a gesture. The
entrance animation's `fill-mode: both` holds `opacity:1, translateY(0)` after 180ms,
which is consistent with the drag resting position.

**`@keyframes ct-popover-enter-keyframes`**:
`translateY(-8px) + scale(0.97) + opacity:0` → `translateY(0) + scale(1) + opacity:1`

**`.ct-popover-enter`**: 160ms `ease-out` entrance, `transform-origin: top right` so the
panel appears to drop from the notification bell corner.

**`.ct-handlebar`**: Standardized handlebar pill.
- Width: `2.5rem` (40px — same as previous `w-10`)
- Height: `4px` (same as previous `h-1`)
- Color: `rgb(209 213 219)` / gray-300 (light), `rgb(75 85 99)` / gray-600 (dark)
- Slightly more visible than the previous `bg-gray-200` (gray-200 = `rgb(229 231 235)`)
- No cursor or interactive state (decorative on non-draggable sheets; the `BottomSheet`
  handle container retains `cursor-grab active:cursor-grabbing` from the wrapper div)

### Sheets updated

| File | What changed |
|---|---|
| `BottomSheet.tsx` | Added `ct-sheet-enter` to panel; handlebar → `ct-handlebar` |
| `CreateEventSheet.tsx` | Added `ct-sheet-enter` to panel; handlebar → `ct-handlebar mx-auto mb-4` |
| `CreateMaintenanceSheet.tsx` | Added `ct-sheet-enter` to panel; handlebar → `ct-handlebar mx-auto mb-4` |
| `CalendarShell.tsx` slot action | Added `ct-sheet-enter`; handlebar → `ct-handlebar mx-auto mb-4` |
| `CalendarShell.tsx` booking sheet | Added `ct-sheet-enter`; handlebar → `ct-handlebar mx-auto mb-4` |
| `EventDetailSheet.tsx` | Added `ct-sheet-enter`; handlebar → `ct-handlebar mx-auto mb-4` |
| `EventRosterSheet.tsx` | Added `ct-sheet-enter`; handlebar → `ct-handlebar mx-auto mb-4` |
| `InviteSheet.tsx` | Added `ct-sheet-enter`; handlebar → `ct-handlebar mx-auto mb-4` |

### Notification panel

**Desktop dropdown** (`NotificationSheet.tsx`):
- Added `ct-popover-enter` to the panel div: smooth drop-down from the bell icon position
- "Mark all read" button: added `hover:text-blue-800 dark:hover:text-blue-300` + transition

**Notification rows**:
- Unread rows (interactive, `cursor-pointer`): added `hover:bg-gray-50 dark:hover:bg-gray-700/40 rounded-lg -mx-2 px-2 motion-safe:transition-colors`
- The `-mx-2 px-2` offset makes the hover background extend to the edge of the panel padding without overflow
- Read rows: unchanged (no interactivity, no hover state)

**Mobile** (uses `BottomSheet`): inherits the `ct-sheet-enter` animation from `BottomSheet.tsx`.

### What was intentionally deferred

- **Exit animations**: would require retained-mount or portal patterns. Entrance-only is
  sufficient for this phase.
- **Drag-to-close on CreateEventSheet / CreateMaintenanceSheet / slot action / booking sheet**:
  these are multi-step forms or calendar-specific flows. Adding drag behavior risks
  accidental dismissal mid-form. The `BottomSheet` reusable component (used by
  `NotificationSheet` and others) already has full drag-to-close.
- **Backdrop fade-in**: the user requested sheet surface animation only.

### QA checklist — Phase 21H-D

**Desktop notification popover:**
- [ ] Clicking the bell opens the panel with a smooth drop-down (160ms)
- [ ] Panel origin feels anchored to the top-right (bell corner)
- [ ] No layout shift on open
- [ ] Unread notification rows show hover background on mouse-over
- [ ] Read notification rows unchanged (no hover state)
- [ ] "Mark all read" button darkens on hover
- [ ] Click-away backdrop closes the panel (unchanged behavior)
- [ ] Notification read/unread logic unchanged

**Mobile notification panel:**
- [ ] Panel slides up 16px + fades in when opened (180ms)
- [ ] Drag handle looks slightly more prominent (gray-300 vs previous gray-200)
- [ ] Drag-to-dismiss still works (BottomSheet logic unchanged)

**Event/block/booking sheets:**
- [ ] CreateEventSheet slides up + fades in on open
- [ ] CreateMaintenanceSheet slides up + fades in on open
- [ ] CalendarShell slot action sheet slides up + fades in on open
- [ ] CalendarShell booking confirmation sheet slides up + fades in on open
- [ ] EventDetailSheet slides up + fades in on open
- [ ] EventRosterSheet slides up + fades in on open
- [ ] InviteSheet slides up + fades in on open

**Handlebars:**
- [ ] All handlebars appear slightly more visible (gray-300 vs gray-200)
- [ ] BottomSheet drag handle retains `cursor-grab` (draggable)
- [ ] Non-draggable handlebars have default cursor (not grab — consistent with "no fake draggable cursor" requirement)

**Reduced motion:**
- [ ] Under `prefers-reduced-motion: reduce`, sheets appear instantly (no slide)
- [ ] Notification popover appears instantly (no drop animation)
- [ ] Existing button/card hover transitions already suppressed by globals.css blanket rule

**No regressions:**
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓
- [ ] Booking flow works end-to-end (no logic change)
- [ ] Event creation flow works end-to-end (no logic change)
- [ ] Block court flow works end-to-end (no logic change)
- [ ] Notification fetch / read / unread / realtime subscription unchanged
- [ ] BottomSheet drag-to-close still works on mobile
- [ ] Header/nav polish from 21H-B/C unchanged

