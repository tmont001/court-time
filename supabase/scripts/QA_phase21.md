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
