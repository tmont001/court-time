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

---

## Checkpoint 21H-E — Mobile Safari form-control theme bugfix

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass; awaiting real-device QA**

### Problem

On a real iPhone in light mode, text inputs inside bottom sheets rendered with a black
background. Surrounding sheet was white; inputs were black. Affected:
- Block Court sheet Reason input (CreateMaintenanceSheet.tsx)
- Create Event Title input (CreateEventSheet.tsx)
Did not reproduce in desktop responsive mode (Chrome DevTools).

### Root cause

Two compounding issues:

1. `colorScheme: "light dark"` in `layout.tsx` Viewport generates
   `<meta name="color-scheme" content="light dark">`. This tells Safari the page
   supports both color schemes. Without a CSS `color-scheme` property set to override
   this, Safari resolves form control appearance using the **OS system preference** —
   not the app's class-based manual toggle. If the iPhone OS is "Dark Mode" but the
   app is in light mode, Safari renders `<input>`, `<select>`, `<textarea>` system
   chrome in dark mode (black backgrounds, white text).

2. Three inputs in the sheet forms lacked an explicit `bg-white` (`background-color:
   white`) for light mode. They relied on browser defaults which, under the dark
   `color-scheme` context Safari selected, rendered as dark.

### Fix

**`src/app/globals.css`** — Added `color-scheme` to the `:root` and `.dark` blocks.
These map exactly to the manual theme toggle (blocking `<script>` in `layout.tsx`
adds/removes `.dark` on `<html>` from `localStorage`). CSS `color-scheme` on `:root`
takes precedence over the meta tag for all form controls within the page.

```css
:root { --accent: #374151; --surface: #f4f5f6; color-scheme: light; }
.dark { --accent: #d1d5db; --surface: #11161f; color-scheme: dark;  }
```

**`src/app/(app)/calendar/CreateEventSheet.tsx`** — Added `bg-white` to:
- Title input (was missing; had `dark:bg-gray-700` but no light-mode bg)
- Custom duration input (same issue)

**`src/app/(app)/calendar/CreateMaintenanceSheet.tsx`** — Added `bg-white` to:
- Notes/Reason input (was missing; had `dark:bg-gray-700` but no light-mode bg)

### Files changed

| File | Change |
|---|---|
| `src/app/globals.css` | Added `color-scheme: light` to `:root` block; `color-scheme: dark` to `.dark` block |
| `src/app/(app)/calendar/CreateEventSheet.tsx` | Added `bg-white` to title input (line 349) and custom duration input (line 441) |
| `src/app/(app)/calendar/CreateMaintenanceSheet.tsx` | Added `bg-white` to notes input (line 310) |

No migrations. No logic changes. No new packages.

### Manual QA checklist

**Light mode on real iPhone (primary test):**
- [ ] Block Court sheet Reason input: white background, dark text, readable placeholder
- [ ] Create Event sheet Title input: white background, dark text, readable placeholder
- [ ] Create Event sheet custom duration input: white background, dark text
- [ ] All other sheet inputs/selects look correct in light mode
- [ ] Profile form inputs (profile page, security page, notifications page) look correct in light mode

**Dark mode on real iPhone:**
- [ ] Block Court sheet Reason input: dark background (gray-700), light text, readable placeholder
- [ ] Create Event sheet Title input: dark background, light text, readable placeholder
- [ ] All other sheet inputs/selects look correct in dark mode

**OS dark + App light (the original bug case):**
- [ ] iPhone OS set to Dark Mode; app manually toggled to light mode
- [ ] Block Court sheet Reason input renders with white background (not black)
- [ ] Create Event sheet Title input renders with white background (not black)

**16px zoom fix preserved:**
- [ ] Tapping any input on iPhone does NOT trigger page zoom
- [ ] `user-scalable` is NOT set (user can still pinch-zoom)

**No regressions:**
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓
- [ ] Sheet animations from 21H-D unchanged
- [ ] Button/card/form-flow polish from 21H-C unchanged
- [ ] Header controls alignment from 21H-B unchanged
- [ ] Booking flow works end-to-end (no logic change)
- [ ] Event creation flow works end-to-end (no logic change)
- [ ] Block court flow works end-to-end (no logic change)

---

## Checkpoint 21I-A — Roster Members Data Model

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass; awaiting SQL Editor deployment + QA**

### What was added

A new `roster_members` table that allows admins to maintain a club membership
directory even when members do not yet have a Supabase Auth account or email
address. This is the data-model foundation for Phase 21I (member roster, bulk
import, and elder-friendly navigation).

### Why profiles was not altered

`profiles.id` is a FK to `auth.users(id)` with CASCADE DELETE. Every RLS policy,
every RPC, and every FK reference (event_participants, reservations, audit_log)
assumes `profiles.id = auth.uid()`. Removing or weakening that FK would require
rewriting every query and policy in the system. A separate `roster_members` table
is additive-only and carries zero risk to existing flows.

### Data model decision

`roster_members` has its own UUID primary key (not tied to auth.users). Key columns:

- `first_name text NOT NULL`, `last_name text NOT NULL` — required
- `email text` — nullable (the whole point: members without email)
- `phone text` — nullable
- `role text default 'member'` — display/intent only, does NOT grant app permissions
- `notes text` — admin notes
- `claimed_by uuid UNIQUE references auth.users(id) ON DELETE SET NULL` — links to
  auth user when member later creates an account
- `created_by uuid NOT NULL references auth.users(id)` — which admin created the entry
- Partial unique index on `(club_id, lower(email)) WHERE email IS NOT NULL` prevents
  duplicate emails within a club

### RLS / security

All four RLS policies (SELECT, INSERT, UPDATE, DELETE) restrict access to admins
in the same club, using existing `current_user_club_id()` and `current_user_role()`
helper functions. Non-admin members cannot see roster_members at all.

All CRUD RPCs are SECURITY DEFINER with the same admin-only gate pattern used by
`set_member_role`, `set_member_status`, `get_members`, etc.

### Claim / link behavior

`accept_club_invite()` was modified (CREATE OR REPLACE, same signature) to add an
auto-link step after the existing audit log entry:

1. Gets the accepting user's email from `auth.users`
2. Searches `roster_members` for an unclaimed row in the same club with matching
   email (case-insensitive)
3. If found: sets `claimed_by = auth.uid()`, copies phone to profile if profile
   phone is null, writes `claim_roster_member` audit entry
4. If not found: does nothing — normal invite acceptance is unaffected

This is a non-blocking convenience. If auto-link fails or no match exists, the
user still joins the club normally through the existing invite flow.

### RPCs added

| RPC | Purpose | Returns |
|---|---|---|
| `get_roster_members()` | Admin: list unclaimed roster members in club | Table of id, names, email, phone, role, notes, created_by, created_at |
| `add_roster_member(...)` | Admin: create roster member with validation + email dedup | New roster_member UUID |
| `update_roster_member(...)` | Admin: update unclaimed roster member | void |
| `delete_roster_member(p_id)` | Admin: delete unclaimed roster member (blocks if claimed) | void |

### RLS policies added

| Policy | Operation | Condition |
|---|---|---|
| `roster_members_select_admin` | SELECT | `club_id = current_user_club_id() AND current_user_role() = 'admin'` |
| `roster_members_insert_admin` | INSERT | same |
| `roster_members_update_admin` | UPDATE | same |
| `roster_members_delete_admin` | DELETE | same |

### Files changed

| File | Change |
|---|---|
| `supabase/migrations/0056_roster_members.sql` | New: table, indexes, RLS, RPCs, accept_club_invite modification |
| `src/lib/db/types.ts` | Added `roster_members` table types + 4 RPC function signatures |
| `supabase/scripts/QA_phase21.md` | This section |

No existing tables altered. No existing RLS policies changed. No UI changes.

### Explicitly deferred items

- Add Member UI (21I-B)
- Bulk CSV import (21I-C)
- Profile → Settings nav rename (21I-D)
- Header user menu / profile dropdown (21I-D)
- Photo / avatar upload (future)
- Multi-profile switching (future)
- `bulk_add_roster_members` RPC (21I-C, when CSV import UI is built)

### Risks and limitations

- `role` on `roster_members` is display/intent only — it is stored for future
  use in the admin UI and CSV import, but does not grant any app permissions.
  Actual permissions come from `profiles.role` after claiming.
- Roster members without email cannot be auto-linked. Admin must manually add
  their email before generating an invite.
- If the accepting user's email differs from the roster entry's email (e.g.,
  admin typed it wrong), auto-link won't match. Admin would reconcile manually.
- `claimed_by` is UNIQUE — one auth user can only claim one roster entry.
- The `accept_club_invite` modification is wrapped in the same transaction as the
  existing invite acceptance. If the roster_members table doesn't exist yet
  (migration not applied), the function will fail — so the migration must be
  applied before any new code deploys.

### QA checklist

**Migration deployment (SQL Editor):**
- [ ] Apply 0056_roster_members.sql in Supabase SQL Editor
- [ ] Verify `roster_members` table exists with correct columns
- [ ] Verify RLS is enabled
- [ ] Verify all 4 RLS policies exist
- [ ] Verify all 4 RPCs exist
- [ ] Verify `accept_club_invite()` was replaced (check for `v_roster_id` variable)

**RPC smoke tests (SQL Editor or Supabase dashboard):**
- [ ] `get_roster_members()` returns empty array for a club with no roster members
- [ ] `add_roster_member('John', 'Smith')` succeeds and returns a UUID
- [ ] `add_roster_member('Jane', 'Doe', 'jane@example.com')` succeeds
- [ ] `add_roster_member('Jim', 'Doe', 'jane@example.com')` fails with `email_already_on_roster`
- [ ] `add_roster_member('', 'Blank')` fails with `first_name_required`
- [ ] `get_roster_members()` returns both John and Jane, ordered by last name
- [ ] `update_roster_member(john_id, 'Jonathan', 'Smith')` succeeds
- [ ] `delete_roster_member(john_id)` succeeds
- [ ] Non-admin user calling any RPC gets `insufficient_role`

**Claim flow (after member signs up via invite):**
- [ ] Admin creates roster member with email (e.g., `test@example.com`)
- [ ] Admin creates invite restricted to that email
- [ ] New user signs up with `test@example.com`, accepts invite
- [ ] `roster_members.claimed_by` is set to the new user's auth ID
- [ ] If roster entry had phone and profile had no phone, phone was copied
- [ ] Audit log contains `claim_roster_member` entry
- [ ] `get_roster_members()` no longer returns the claimed entry

**Invite flow without roster match:**
- [ ] User signs up and accepts invite with no matching roster entry
- [ ] Invite acceptance works normally (no errors)
- [ ] No `claim_roster_member` audit entry

**No regressions:**
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓
- [ ] Existing invite flow unchanged (generate → share → accept)
- [ ] Existing member role/status management unchanged
- [ ] Booking flow works end-to-end
- [ ] Event join/leave flows work
- [ ] Notifications unchanged

---

## Checkpoint 21I-B — Admin Add Member UI + Unified List

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass; awaiting real-device QA**

### What was added

Admin UI on `/admin/members` for creating, editing, and deleting offline/unclaimed
roster members. The member list now shows both auth-linked members (from
`get_members`) and unclaimed roster members (from `get_roster_members`) in a
single unified, sortable view.

### UI behavior

**Add Member button:**
- Solid dark button next to existing "+ Invite" button
- Opens `AddMemberSheet` bottom sheet

**AddMemberSheet form:**
- Title: "Add Member"
- Helper text: "Add someone to the club roster. They do not need an online account yet."
- Fields: First name (required), Last name (required), Email (optional), Phone (optional), Role (pill buttons: Member/Pro/Admin, default Member), Notes (optional)
- Email helper: "Optional — you can add this later if they want to sign in."
- Role helper: "For your reference. App access requires signing up."
- On success: green banner "Added [Name] to the roster." with "Add Another" and "Done" buttons
- On error: red text below submit button with friendly messages

**Edit mode:**
- Same sheet with title "Edit Member", pre-filled fields
- Submit calls `update_roster_member` RPC
- On success: closes sheet and refreshes

**Unified member list:**
- Auth-linked members: same card design as before (name, status badge, email, phone, join date, role dropdown, deactivate button)
- Roster members: card with name, amber "No account yet" badge, email/phone/notes if present, role label, "Added [date]"
- Roster member actions: Edit, Remove, Send Invite (only if email present)
- Sort controls work across both types (first name, last name, role, status)
- Roster members sort as "no_account" status (after active and inactive)
- Total member count shown in header

**Delete roster member:**
- Confirmation dialog: "Remove [Name] from the roster?"
- Helper: "This only removes the roster entry. It does not affect any signed-in account."
- Cancel / Remove buttons

**Send Invite for roster member:**
- Opens existing InviteSheet pre-filled with the roster member's email
- InviteSheet gained an `initialEmail` prop (minimal change)

### Error messages

| RPC error | User-facing message |
|---|---|
| `first_name_required` | Please enter a first name. |
| `last_name_required` | Please enter a last name. |
| `email_already_on_roster` | This email is already on the roster. |
| `email_already_a_member` | This email already belongs to a member. |
| `roster_member_not_found` | Roster member not found. |
| `roster_member_already_claimed` | This member has already created an account. |
| `insufficient_role` | Only admins can manage members. |
| fallback | Something went wrong. Please try again. |

---

## Checkpoint 21I-C-A — Migration + RPCs for Member Notes and Roster Events

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass; awaiting SQL Editor deployment + QA**

### What was added

Data model and RPC foundation for two features:

1. **Admin notes on signed-in members** — `profiles.admin_notes` column + `set_member_notes` RPC
   + updated `get_members()` to return admin_notes.
2. **Roster members in events** — `event_guests.roster_member_id` FK + `admin_add_roster_member_to_event`
   RPC + updated `get_event_roster()` to return roster_member_id.

### Data model decisions

**Admin notes:**
- Column: `profiles.admin_notes text` (nullable, default null)
- Admin-editable only via `set_member_notes` SECURITY DEFINER RPC
- Returned by `get_members()` (admin-only RPC) for admin UI use
- Known limitation: `profiles_select_same_club` RLS means club members could technically
  read admin_notes by querying profiles directly. Acceptable for pilot — app UI only
  shows notes to admins. For non-sensitive operational notes only.

**Roster members in events:**
- Column: `event_guests.roster_member_id uuid references roster_members(id) on delete set null`
- Partial unique index: `(event_id, roster_member_id) WHERE roster_member_id IS NOT NULL`
  prevents adding the same roster member to an event twice
- Roster members are stored as event_guests (always count toward capacity, no waitlist,
  no notifications) — this reuses existing guest capacity/removal logic with zero
  changes to waitlist/offer/notification flows
- ON DELETE SET NULL: if roster member is deleted, guest entry stays but link is lost

### Known limitations

- admin_notes are for operational, non-sensitive notes only (see RLS caveat above)
- Roster event entries do NOT auto-convert when a roster member later claims an
  account. The admin must manually remove the guest and add the now-signed-in member
  as a real participant. Auto-conversion deferred to a future phase.
- Roster-linked guests have no waitlist/offer flow (they can't respond — no account)
- Roster-linked guests receive no notifications

### Security notes

- `set_member_notes`: admin-only gate, same-club scoped, audit logged. No self-edit
  restriction (admins can note themselves). No last-admin guard needed.
- `admin_add_roster_member_to_event`: admin/pro gate (matches admin_add_guest pattern),
  same-club scoped, validates event is scheduled and roster member is in same club.
  Audit logged with was_over_capacity field.
- No existing RLS policies changed. No existing tables altered beyond adding columns.

### RPCs added / modified

| RPC | Type | Notes |
|---|---|---|
| `set_member_notes(p_target_user_id, p_notes)` | New | Admin-only, writes profiles.admin_notes |
| `admin_add_roster_member_to_event(p_event_id, p_roster_member_id)` | New | Admin/pro, creates linked event_guests row |
| `get_members()` | Modified | Added `admin_notes` to return columns |
| `get_event_roster(p_event_id)` | Modified | Added `roster_member_id` to return columns |

### Columns / indexes added

| Table | Column / Index | Details |
|---|---|---|
| `profiles` | `admin_notes text` | Nullable, admin-editable only |
| `event_guests` | `roster_member_id uuid` | FK to roster_members, ON DELETE SET NULL |
| `event_guests` | `event_guests_roster_member_uniq` | Partial unique on (event_id, roster_member_id) |

### Files changed

#### 21I-B files

| File | Change |
|---|---|
| `src/app/(app)/admin/members/AddMemberSheet.tsx` | New: add/edit roster member sheet component |
| `src/app/(app)/admin/members/MembersClient.tsx` | Rewritten: unified list, roster cards, edit/delete dialogs, invite prefill |
| `src/app/(app)/admin/members/actions.ts` | Added: `addRosterMemberAction`, `updateRosterMemberAction`, `deleteRosterMemberAction` + roster error messages |
| `src/app/(app)/admin/members/InviteSheet.tsx` | Added: `initialEmail` optional prop |
| `src/app/(app)/admin/members/page.tsx` | Added: `get_roster_members` RPC call, passes `rosterMembers` prop |
| `supabase/scripts/QA_phase21.md` | This section |

No migrations. No existing tables altered. No existing RLS changed.

#### 21I-C-A files

| File | Change |
|---|---|
| `supabase/migrations/0057_member_notes_and_roster_events.sql` | New migration |
| `src/lib/db/types.ts` | Updated profiles, event_guests, get_members, get_event_roster types; added set_member_notes, admin_add_roster_member_to_event signatures |
| `supabase/scripts/QA_phase21.md` | This section |

No UI changes. No existing tables altered beyond adding nullable columns.

### Explicitly deferred items

- Admin member card inline notes editing UI (21I-C-B)
- EventRosterSheet unified member picker with roster members (21I-C-B)
- Event roster "No account yet" badge display (21I-C-B)
- Server actions for set_member_notes and admin_add_roster_member_to_event (21I-C-B)
- Bulk CSV import (21I-D)
- Profile → Settings nav rename (future)
- Header user menu / profile dropdown (future)
- Photo / avatar upload (future)
- Multi-profile switching (future)

### QA checklist — 21I-B (Admin Add Member UI)

**Add member — happy path:**
- [ ] Admin can add member with first/last name only → appears with "No account yet" badge
- [ ] Admin can add member with email → email shown on card
- [ ] Admin can add member with phone → phone shown on card
- [ ] Admin can add member with notes → notes shown on card (italic)
- [ ] Admin can add member with Pro or Admin role → role shown on card
- [ ] Success message shows member name: "Added John Smith to the roster."
- [ ] "Add Another" resets form and allows adding more
- [ ] "Done" closes sheet

**Add member — validation:**
- [ ] Missing first name → "Please enter a first name."
- [ ] Missing last name → "Please enter a last name."
- [ ] Duplicate email (already on roster) → "This email is already on the roster."
- [ ] Duplicate email (already a member) → "This email already belongs to a member."

**Unified member list:**
- [ ] Auth-linked members show with Active/Inactive badge, role dropdown, deactivate button
- [ ] Roster members show with "No account yet" amber badge, Edit/Remove/Send Invite buttons
- [ ] Sort by First Name works across both types
- [ ] Sort by Last Name works across both types
- [ ] Sort by Role works across both types
- [ ] Sort by Status works (active → inactive → no account)
- [ ] Total count shown in header

**Edit roster member:**
- [ ] Edit button opens sheet pre-filled with existing data
- [ ] Title shows "Edit Member"
- [ ] Changing name and saving works → card updates
- [ ] Adding email to previously email-less member works
- [ ] Duplicate email check fires on edit

**Delete roster member:**
- [ ] Remove button opens confirmation dialog
- [ ] Dialog shows member name and explanation text
- [ ] Cancel closes dialog without deleting
- [ ] Remove deletes member and refreshes list
- [ ] Cannot delete claimed roster member (error shown)

**Send Invite:**
- [ ] "Send Invite" button only appears on roster members with email
- [ ] Clicking opens InviteSheet with email pre-filled
- [ ] Invite sheet works normally with pre-filled email

**Existing features unchanged:**
- [ ] Existing invite flow (+ Invite button) still works
- [ ] Member role dropdown still works for auth-linked members
- [ ] Deactivate/Reactivate still works for auth-linked members
- [ ] Pending invites section unchanged
- [ ] Non-admin redirected to /calendar

**Mobile + dark mode:**
- [ ] All new UI works on mobile (sheets, cards, dialogs)
- [ ] Add Member sheet scrollable on small screens
- [ ] All components render correctly in dark mode
- [ ] Large tap targets on buttons (≥ 44px)
- [ ] No regressions: pnpm tsc --noEmit ✓ / pnpm build ✓

### QA checklist — 21I-C-A (Migration + RPCs)

**Migration deployment (SQL Editor):**
- [ ] Apply 0057_member_notes_and_roster_events.sql
- [ ] Verify profiles.admin_notes column exists
- [ ] Verify event_guests.roster_member_id column exists
- [ ] Verify event_guests_roster_member_uniq index exists
- [ ] Verify set_member_notes function exists
- [ ] Verify admin_add_roster_member_to_event function exists
- [ ] Verify get_members returns admin_notes
- [ ] Verify get_event_roster returns roster_member_id

**set_member_notes RPC smoke tests:**
- [ ] Admin calls set_member_notes('target_id', 'Test note') → succeeds
- [ ] get_members() returns admin_notes='Test note' for that member
- [ ] Admin calls set_member_notes('target_id', null) → clears notes
- [ ] Admin calls set_member_notes('target_id', '  ') → normalises to null
- [ ] Non-admin gets insufficient_role error
- [ ] Cross-club target gets user_not_found error
- [ ] Audit log contains set_member_notes entry

**admin_add_roster_member_to_event RPC smoke tests:**
- [ ] Admin creates roster member, creates event, calls admin_add_roster_member_to_event → event_guests row created
- [ ] get_event_roster returns the roster-linked guest with roster_member_id set
- [ ] Regular guests in same event have roster_member_id = null
- [ ] Adding same roster member to same event twice → unique constraint error
- [ ] Non-admin/non-pro gets admin_required error
- [ ] Cancelled event → event_cancelled error
- [ ] Roster member from different club → roster_member_not_found error
- [ ] Claimed roster member → roster_member_already_claimed error
- [ ] Removing roster-linked guest via admin_remove_guest works (triggers queue advance if slot freed)
- [ ] Capacity counting includes roster-linked guest (same as regular guest)
- [ ] Audit log contains admin_add_roster_member_to_event entry with was_over_capacity

**Existing behavior preserved:**
- [ ] get_members still returns all existing columns correctly
- [ ] get_event_roster still returns members and guests correctly (new column is null for members, null for unlinked guests)
- [ ] admin_add_guest still works for anonymous guests (roster_member_id defaults to null)
- [ ] admin_remove_guest still works
- [ ] join_event / leave_event unchanged
- [ ] Waitlist offer/accept/decline flows unchanged
- [ ] Notifications unchanged
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21I-C-B — Admin Notes UI + Roster Members in Events UI

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

**Known limitation:** Full browser testing requires applying 0056 and 0057 in Supabase first.

### What was added

UI for two features:

1. **Admin notes on signed-in members** — inline editable notes on each ProfileCard
   in `/admin/members`. Click "Add notes" or existing notes text to edit. Save on
   Enter or Save button. Cancel on Escape. Shows "Saving…" and "Saved" feedback.
2. **Roster members in events** — the "Add Member" picker in EventRosterSheet now
   includes unclaimed roster members alongside signed-in members. Roster members
   are labeled "(No account yet)" in the picker. When added, they are stored as
   linked event_guests (counting toward capacity). The roster shows "No account yet"
   badge for roster-linked guests and "Guest" for anonymous guests.

### UI behavior

**Admin notes on ProfileCards:**
- Empty state: gray "Add notes" text
- Populated state: italic gray notes text
- Click → inline text input with Save/Cancel buttons
- Enter key saves, Escape cancels
- "Saving…" during RPC call, "Saved" flash on success
- Error message on failure
- Does not show on member-facing profile pages

**Event roster add-member picker:**
- Fetches both `profiles` (active, same club) and `get_roster_members()` (unclaimed)
- Signed-in members: "First Last"
- Roster members: "First Last (No account yet)"
- Sorted alphabetically across both types
- Selecting a signed-in member → calls `adminAddMember` (existing flow, with waitlist)
- Selecting a roster member → calls `adminAddRosterMemberToEvent` (new, always confirmed)
- Members already in the event are excluded from both lists

**Event roster guest display:**
- Roster-linked guests: amber "No account yet" badge
- Anonymous guests: gray "Guest" badge
- Both use existing Remove action via `adminRemoveGuest`

### Error messages added

Event roster errors:
- `roster_member_not_found` → "That roster member could not be found."
- `roster_member_already_claimed` → "This member already has an account. Add them as a signed-in member instead."
- Duplicate unique constraint → "This member is already on the event roster."
- `admin_required` / `insufficient_role` → "Only admins and pros can manage event rosters."

### Files changed

| File | Change |
|---|---|
| `src/app/(app)/admin/members/MembersClient.tsx` | Added `admin_notes` to Member type; ProfileCard now has inline notes editing with save/cancel/feedback |
| `src/app/(app)/admin/members/actions.ts` | Added `setMemberNotesAction` server action |
| `src/app/(app)/admin/events/actions.ts` | Added `adminAddRosterMemberToEvent` server action + roster error messages |
| `src/app/(app)/calendar/EventRosterSheet.tsx` | Unified add-member picker (profiles + roster members); roster-linked guest badges; `roster_member_id` on RosterRow |
| `supabase/scripts/QA_phase21.md` | This section |

### QA checklist — Admin notes

- [ ] Signed-in member card shows "Add notes" when notes are empty
- [ ] Clicking "Add notes" opens inline text input
- [ ] Typing and pressing Enter saves notes
- [ ] "Saving…" shown during save
- [ ] "Saved" shown briefly after success
- [ ] Notes appear as italic text on card after save
- [ ] Clicking existing notes opens edit mode pre-filled
- [ ] Pressing Escape cancels edit without saving
- [ ] Clearing text and saving removes notes (shows "Add notes" again)
- [ ] Error message shown if RPC fails
- [ ] Roster member notes (from roster_members.notes) still display correctly
- [ ] Admin notes are NOT visible on member-facing profile pages

### QA checklist — Roster members in events

- [ ] EventRosterSheet "Add Member" picker shows signed-in members without suffix
- [ ] Picker also shows roster members with "(No account yet)" suffix
- [ ] Members already in the event are excluded from picker
- [ ] Selecting a signed-in member and clicking Add → uses admin_add_member flow
- [ ] Selecting a roster member and clicking Add → uses admin_add_roster_member_to_event flow
- [ ] Added roster member appears in Guests section with "No account yet" badge
- [ ] Anonymous guests still show "Guest" badge
- [ ] Removing a roster-linked guest works (uses admin_remove_guest)
- [ ] Adding same roster member twice → "This member is already on the event roster."
- [ ] Adding a claimed roster member → friendly error message
- [ ] Capacity counting includes roster-linked guests
- [ ] Signed-in member add/remove/waitlist/offer behavior unchanged
- [ ] Guest add/remove behavior unchanged

### QA checklist — No regressions

- [ ] Existing signed-in member cards work (role dropdown, deactivate)
- [ ] Add Member sheet for roster members works
- [ ] Edit/delete roster members works
- [ ] Pending invites section works
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21I-D — Event Roster Label Polish

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### What changed

The event roster sheet now separates roster-linked no-account members from
anonymous guests into distinct sections instead of grouping them together under
"Guests." No database changes.

**Before:** All guest-role rows appeared under one "GUESTS (N)" section with
inline badges ("No account yet" or "Guest") to distinguish them.

**After:** Three possible sections in the guest area:
- **NO ACCOUNT YET (N)** — amber header, roster-linked members only
- **GUESTS (N)** — gray header, anonymous guests only

Sections only appear when they have rows. Removal behavior is unchanged
(both use `adminRemoveGuest`). Capacity counting is unchanged (both types
count toward capacity as event_guests).

### Files changed

| File | Change |
|---|---|
| `src/app/(app)/calendar/EventRosterSheet.tsx` | Split `guests` array into `rosterGuests` + `anonGuests`; render as two separate sections |
| `supabase/scripts/QA_phase21.md` | This section |

No database changes. No migration changes. No logic changes.

### QA checklist

- [ ] Roster-linked no-account members appear under "NO ACCOUNT YET" section (amber header)
- [ ] Anonymous guests appear under "GUESTS" section (gray header)
- [ ] Section counts are correct for each
- [ ] Sections only appear when they have rows
- [ ] Remove button works on roster-linked members (uses adminRemoveGuest)
- [ ] Remove button works on anonymous guests (uses adminRemoveGuest)
- [ ] Signed-in members still appear under SIGNED-IN MEMBERS / OFFERED / WAITLISTED
- [ ] Add Member picker still shows both signed-in and roster members
- [ ] Capacity counting unchanged
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21I-D addendum — Roster wording clarification

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### What changed

- Added "N attending" total below the "Roster" title (counts confirmed signed-in
  members + no-account roster members + anonymous guests; excludes waitlisted/offered)
- Renamed the confirmed section from "CONFIRMED (N)" to "SIGNED-IN MEMBERS (N)"
- OFFERED / WAITLISTED / NO ACCOUNT YET / GUESTS sections unchanged

No database changes. No logic changes.

### QA checklist

- [ ] "N attending" total shown under Roster title
- [ ] Total counts confirmed + no-account + guests (not waitlisted, not offered)
- [ ] Total hidden while loading or on error
- [ ] Total hidden when 0 attending
- [ ] Section header reads "SIGNED-IN MEMBERS (N)" not "CONFIRMED (N)"
- [ ] OFFERED section unchanged
- [ ] WAITLISTED section unchanged
- [ ] NO ACCOUNT YET section unchanged
- [ ] GUESTS section unchanged
- [ ] No database files changed
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21J-A — Events and My Schedule Cleanup

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### Root cause of /events flicker

Event cards in `/events/page.tsx` used `ct-card-interactive`, which applies
`transform: translateY(-1px)` on `:hover`. When the cursor was near the card's
bottom edge, the card physically moving up 1px pushed the cursor outside the
card boundary, triggering hover-off. The card snapped back, cursor was inside
again, hover-on fired, card moved up — and the cycle repeated infinitely.

Fix: changed event cards from `ct-card-interactive` to `ct-card`. The cards
are not interactive divs (no onClick); the action buttons inside them handle
interaction. This eliminates the transform on hover without affecting any button
behavior or styles.

### My Schedule past events

Added the event date to each past event row (`Mon, Jun 23 · 9:00 AM – 10:00 AM`).
Past events now clearly show when they occurred. Also:
- Added helper text: "Your event history. Past events are read-only."
- Reduced card opacity to 0.75 to visually distinguish past from upcoming
- Changed the empty attendance indicator from `—` to `Past`

No delete functionality added — past events remain read-only history.

### Navigation direction note

Future intended direction:
- `/calendar` becomes the main schedule hub
- Future calendar views may include Day / Week / List options
- `/events` may later become a list view within calendar or redirect
- `/my-schedule` remains the personal member schedule and history view
- No nav merge in this phase

### Files changed

| File | Change |
|---|---|
| `src/app/(app)/events/page.tsx` | `ct-card-interactive` → `ct-card` on event cards (fixes flicker) |
| `src/app/(app)/my-schedule/page.tsx` | Added `formatDateShort`; past events show date + time; helper text; visual dimming |
| `supabase/scripts/QA_phase21.md` | This section |

No database changes. No migrations.

### QA checklist

**Events page flicker:**
- [ ] Hover cursor over event card edge — no flicker, no oscillation
- [ ] Join / Leave / Accept / Pass buttons still respond to hover
- [ ] EventRosterSheet opens correctly on click (admin/pro)

**My Schedule past events:**
- [ ] Past event rows show date (e.g., "Mon, Jun 23 · 9:00 AM – 10:00 AM")
- [ ] Helper text "Your event history. Past events are read-only." appears
- [ ] Past event cards are slightly dimmed
- [ ] No delete/remove buttons on past events
- [ ] Attendance: Attended (green), No-show (red), Past (gray default)
- [ ] Upcoming events and reservations unchanged

**No regressions:**
- [ ] Join/Leave/Accept/Pass actions work on /events
- [ ] My Schedule upcoming items unchanged
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21J-B — Responsive Event Overlays

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### What changed

Added a shared `ResponsiveSheet` component and wired four event-related overlays
to use it. On mobile (< 768px) behavior is unchanged — all four continue to slide
up from the bottom. On desktop (≥ 768px) they no longer behave as bottom sheets.

### New component: `src/components/ResponsiveSheet.tsx`

Detects viewport via `matchMedia("min-width: 768px")` on mount and live. Two
desktop variants:
- `variant="modal"` — centered dialog, `max-w-lg max-h-[85vh]`, `ct-modal-enter`
  fade-in + scale animation, semi-transparent backdrop, × close button, Escape key.
- `variant="panel"` — right-side panel, `w-[440px]`, `ct-panel-enter` slide-in
  animation, semi-transparent backdrop, × close button, Escape key, independent scroll.

Mobile path: `fixed bottom-0 left-0 right-0 rounded-t-2xl ct-sheet-enter` (same
as before, no drag-to-dismiss — use BottomSheet directly if that's needed).

### Two new animation classes in `globals.css`
- `ct-modal-enter` — fade-in + scale(0.97→1), 150ms ease-out
- `ct-panel-enter` — translateX(24px→0) + fade-in, 180ms ease-out

### Wired overlays

| Overlay | Mobile | Desktop |
|---|---|---|
| EventDetailSheet | Bottom sheet (unchanged) | Centered modal |
| EventRosterSheet | Bottom sheet z-60/70 (unchanged) | Right-side panel |
| CalendarShell slot action menu | Bottom sheet (unchanged) | Centered modal |
| CalendarShell booking confirmation | Bottom sheet (unchanged) | Centered modal |

### What was NOT changed (deferred)
- `CreateEventSheet` — still bottom sheet on desktop
- `CreateMaintenanceSheet` — still bottom sheet on desktop
- `InviteSheet` — still bottom sheet on desktop
- `AddMemberSheet` — still bottom sheet on desktop
- `BottomSheet.tsx` — unchanged
- `NotificationSheet.tsx` — unchanged (already had its own responsive logic)

### Mobile/desktop behavior details

**EventDetailSheet (desktop modal):**
- Centered, `max-w-lg`. Handle pill hidden on desktop (`md:hidden`).
- ResponsiveSheet provides × close button top-right.
- All Join/Leave/Accept/Pass/Cancel Event actions unchanged.
- Event Roster sheet opens on top (z-50+) when admin taps View Roster.

**EventRosterSheet (desktop right panel):**
- `w-[440px]` panel slides in from right. Independent scroll (`overflow-y-auto flex-1`).
- Handle pill and inline "Close" button hidden on desktop (`md:hidden`).
- ResponsiveSheet provides × close button top-right (title row padded `pr-8` to avoid overlap).
- Mobile z-index overrides preserved: backdrop z-60, panel z-70 (layers above EventDetailSheet).
- All roster actions (add member, add roster member, add guest, force confirm, offer spot, remove) unchanged.

**CalendarShell slot action + booking confirmation (desktop modal):**
- Centered modal. Handle pill hidden on desktop. Title padded `pr-8` to clear × button.
- All booking/slot actions unchanged.

### QA checklist

**Mobile (< 768px) — must behave exactly as before:**
- [ ] EventDetailSheet slides up from bottom, backdrop click closes
- [ ] EventRosterSheet slides up from bottom (z-70), handle pill visible
- [ ] Slot action menu slides up from bottom
- [ ] Booking confirmation slides up from bottom

**Desktop (≥ 768px) — new behavior:**
- [ ] EventDetailSheet opens as centered modal (not bottom pull-up)
- [ ] EventDetailSheet handle pill NOT visible on desktop
- [ ] EventDetailSheet × close button visible top-right
- [ ] EventDetailSheet backdrop click closes
- [ ] EventDetailSheet Escape key closes
- [ ] EventDetailSheet Join/Leave/Accept/Pass/Cancel Event all work
- [ ] EventRosterSheet opens as right-side panel (not bottom pull-up)
- [ ] EventRosterSheet panel has independent scroll for long rosters
- [ ] EventRosterSheet "Close" text hidden on desktop (× button used instead)
- [ ] EventRosterSheet handle pill NOT visible on desktop
- [ ] EventRosterSheet backdrop click closes
- [ ] EventRosterSheet add member picker works
- [ ] EventRosterSheet remove/force confirm/offer spot all work
- [ ] Slot action menu opens as centered modal
- [ ] Booking confirmation opens as centered modal with duration picker working
- [ ] All desktop overlays have semi-transparent backdrop
- [ ] All desktop overlays have × close button

**No regressions:**
- [ ] NotificationSheet desktop popover unchanged
- [ ] NotificationSheet mobile bottom sheet unchanged
- [ ] CreateEventSheet still works (not changed in this phase)
- [ ] CreateMaintenanceSheet still works (not changed)
- [ ] InviteSheet / AddMemberSheet still work (not changed)
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21J-B addendum — Four QA fixes

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### Root causes and fixes

**Issue 1 — CreateEventSheet and CreateMaintenanceSheet still bottom sheets on desktop**
Both used hardcoded `fixed bottom-0 ... max-h-[88dvh]` containers. Wrapped both
with `<ResponsiveSheet variant="modal">`. CreateEventSheet uses `size="wide"` (max-w-2xl)
because of the multi-step court selection layout. Handle pills hidden on desktop.

**Issue 2 — No Back button in slot flow**
`openBookingFromSlot/openEventFromSlot/openBlockFromSlot` all called
`setPendingSlotAction(null)`, losing the ability to return to the slot menu.
Fix: removed those `setPendingSlotAction(null)` calls. Added `backToSlotMenu()`
(clears sub-form state, keeps pendingSlotAction) and `closeSlotFlow()` (clears
everything). Slot menu now hides via `!bookingSlot && !creatingEvent && !creatingBlock`
condition. Added a "← Back" button in the booking confirmation sheet (when arrived
from a slot). Added `onBack?: () => void` prop to CreateEventSheet (shows "← Back"
at step 1) and CreateMaintenanceSheet. CalendarShell passes `onBack={slotPreFill ?
backToSlotMenu : undefined}` so Back only appears when the sheet was opened from a slot.

**Issue 3 — Backdrop click not closing desktop modal**
The centering flex div (`fixed inset-0 z-50`) sat above the backdrop (`z-40`), so
clicks outside the modal box hit the flex container silently. Fix: added
`onClick={onClose}` to the centering div. Inner modal div's `stopPropagation()`
prevents modal content clicks from triggering it.

**Issue 4 — Roster not updating after join/leave**
EventRosterSheet only reloaded on mount and after its own admin actions. After a
user joined/left via EventDetailSheet's buttons, the open roster panel showed stale
data. Fix: added `refreshTick?: number` prop to EventRosterSheet; a `useEffect`
calls `loadRoster()` whenever refreshTick increments. EventDetailSheet now has a
`rosterRefreshTick` state that increments on successful join and leave.

### Files changed in this addendum

| File | Change |
|---|---|
| `src/components/ResponsiveSheet.tsx` | Backdrop click fix; removed extra scroll wrapper; added `size` prop (default/wide) |
| `src/app/(app)/calendar/EventDetailSheet.tsx` | Added rosterRefreshTick; passes to EventRosterSheet; content div gets overflow-y-auto flex-1 |
| `src/app/(app)/calendar/EventRosterSheet.tsx` | Added `refreshTick` prop; reloads roster when tick increments |
| `src/app/(app)/calendar/CreateEventSheet.tsx` | Wrapped with ResponsiveSheet (size="wide"); added onBack prop |
| `src/app/(app)/calendar/CreateMaintenanceSheet.tsx` | Wrapped with ResponsiveSheet; added onBack prop |
| `src/app/(app)/calendar/CalendarShell.tsx` | backToSlotMenu/closeSlotFlow helpers; Back button in booking sheet; onBack/onClose for CreateEvent/CreateMaintenance |

### QA checklist — four fixes

**Issue 1 (Create sheets on desktop):**
- [ ] Creating an event from FAB button opens as desktop modal
- [ ] Creating event from empty slot tap opens as desktop modal
- [ ] "← Back" (between steps) still works inside CreateEventSheet
- [ ] Step counter "1 of 4" still visible
- [ ] Creating a maintenance block opens as desktop modal
- [ ] Both are still bottom sheets on mobile

**Issue 2 (Back button in slot flow):**
- [ ] Tap empty slot → slot menu appears
- [ ] Tap "Book Court" → booking form opens, "← Back" visible
- [ ] Tap "← Back" → returns to slot menu (same slot, not closed)
- [ ] Tap "Create Event" → event form opens, "← Back" visible at step 1
- [ ] Tap "← Back" in event form → returns to slot menu
- [ ] Tap "Maintenance Block" → block form opens, "← Back" visible
- [ ] Tap "← Back" in block form → returns to slot menu
- [ ] × (close) closes entire slot flow (slot menu + form)
- [ ] Clicking backdrop on desktop closes entire slot flow
- [ ] Escape key closes entire slot flow
- [ ] FAB "Create Event" button: opens event form with NO "← Back" (not from slot)
- [ ] FAB "+ Block" button: opens block form with NO "← Back" (not from slot)

**Issue 3 (Backdrop click):**
- [ ] Click outside event detail modal → modal closes
- [ ] Click inside event detail modal → modal stays open
- [ ] Click outside event roster panel → panel closes
- [ ] Click outside booking confirmation modal → modal closes
- [ ] Click outside slot action modal → modal closes
- [ ] Click outside Create Event modal → modal closes
- [ ] Click outside Create Maintenance modal → modal closes

**Issue 4 (Roster updates after join/leave):**
- [ ] Open event detail, open roster panel, join event → roster reloads showing new participant
- [ ] Open event detail, open roster panel, leave event → roster reloads removing participant
- [ ] Waitlist join: roster shows member as waitlisted after joining full event

**No regressions:**
- [ ] All existing modal and panel behaviors from 21J-B still work
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21I-E — Bulk Member Import

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### What was added

A bulk CSV import workflow on `/admin/members`. Admins can upload a spreadsheet
of member names (and optionally email/phone/notes) and add them all as no-account
roster members at once.

No database schema changes. No new migrations. No new packages. Reuses the existing
`add_roster_member` RPC via a new `importRosterMembersAction` server action.

### Import flow

1. Admin clicks **Import Spreadsheet** on the `/admin/members` action row.
2. Sheet opens (desktop: wide modal; mobile: bottom sheet).
3. Admin downloads the template CSV if needed.
4. Admin uploads their CSV file (`.csv` only, max 200 rows).
5. Browser parses and validates the file instantly.
6. Preview table shows all rows with per-row status (Ready / Warning / Error).
7. Admin reviews, optionally checks "Include rows with warnings."
8. Admin clicks "Import N Members."
9. Server adds each valid row as a roster member with role=member.
10. Summary shows imported count, skipped rows, and error details.
11. Clicking "Done" refreshes the member list.

### Validation rules

**Hard errors (always skipped):**
- Missing first name
- Missing last name
- Invalid email format (if email provided)
- File has > 200 data rows

**Warnings (skipped by default; admin can include via checkbox):**
- Duplicate email within the uploaded CSV
- Duplicate first+last name within the uploaded CSV
- Email matches an existing unclaimed roster member
- First+last name matches an existing unclaimed roster member

**Post-import server errors (shown in summary):**
- `email_already_on_roster` — rare (race condition or existing roster member missed client-side)
- `email_already_a_member` — email belongs to a signed-in profile (not checked client-side)

### CSV parser

Browser-side, no library. Handles:
- UTF-8 BOM (Excel CSV exports)
- CRLF and LF line endings
- Quoted fields with embedded commas (e.g. notes: `"Likes doubles, clinics"`)
- Escaped quotes inside quoted fields

### Accepted column headers (case-insensitive)

| Canonical | Also accepted |
|---|---|
| `first_name` | `First Name`, `firstname`, `first` |
| `last_name` | `Last Name`, `lastname`, `last` |
| `email` | `Email Address`, `emailaddress` |
| `phone` | `Phone Number`, `phonenumber` |
| `notes` | `admin notes`, `adminnotes`, `note` |

### Files changed

| File | Change |
|---|---|
| `src/app/(app)/admin/members/ImportMembersSheet.tsx` | **New** — full import wizard component |
| `src/app/(app)/admin/members/actions.ts` | Added `importRosterMembersAction` + `ImportRowInput`/`ImportResult` types |
| `src/app/(app)/admin/members/MembersClient.tsx` | Added "Import Spreadsheet" button; wired `ImportMembersSheet` |
| `supabase/scripts/QA_phase21.md` | This section |

No migrations. No schema changes. No new packages.

### QA checklist

**Template download:**
- [ ] "Download template CSV" downloads `court-time-members-template.csv`
- [ ] Template has headers: `first_name,last_name,email,phone,notes`
- [ ] Template includes 2 example rows

**File upload:**
- [ ] Accepts `.csv` files
- [ ] Rejects non-CSV files with clear message
- [ ] Handles Excel-exported CSV (UTF-8 BOM)
- [ ] Handles CRLF line endings
- [ ] Handles quoted fields with embedded commas in notes
- [ ] > 200 rows shows a clear error before preview
- [ ] Blank rows are silently skipped

**Preview table:**
- [ ] All rows appear with correct data in columns
- [ ] Row with missing first name shows ✗ Error status
- [ ] Row with missing last name shows ✗ Error status
- [ ] Row with invalid email shows ✗ Error status
- [ ] Row with duplicate email in file shows ⚠ Warning
- [ ] Row with duplicate name in file shows ⚠ Warning
- [ ] Row with email matching existing roster member shows ⚠ Warning
- [ ] Row with name matching existing roster member shows ⚠ Warning
- [ ] Footer shows correct counts (N ready · M warnings · K errors)
- [ ] Error rows shown with dim/strikethrough styling

**Warnings checkbox:**
- [ ] "Include rows with warnings" checkbox shown only when warnings exist
- [ ] Checkbox defaults to unchecked
- [ ] Checking it increases the import button count
- [ ] Unchecking it decreases the import button count back

**Import button:**
- [ ] Button disabled when 0 rows to import (all errors, no warnings included)
- [ ] Button label shows correct count: "Import N Members"
- [ ] Button shows "importing" state while server call is in progress
- [ ] Error rows are never imported regardless of checkbox state

**Summary:**
- [ ] All successful: "Added N members to the roster."
- [ ] Partial: "Added N of M members. K rows were skipped."
- [ ] All failed: "No members were added. See details below."
- [ ] Server-side errors (e.g. email_already_a_member) shown in skipped list
- [ ] Skipped rows show member name and reason

**After "Done":**
- [ ] Member list refreshes showing newly imported members
- [ ] All imported members have "No account yet" badge
- [ ] Imported members have correct first/last name, email, phone, notes

**No regressions:**
- [ ] "+ Add Member" (single) sheet still works
- [ ] Edit roster member still works
- [ ] Existing invite flow unchanged
- [ ] Member role/status/notes management unchanged
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

**Desktop/mobile:**
- [ ] Import sheet opens as wide desktop modal
- [ ] Preview table scrolls horizontally on narrow screens
- [ ] Works on mobile (file picker opens, import proceeds)

**Button clarity polish (final 21I-E adjustment):**
"Import Spreadsheet" button received a solid background (`bg-white dark:bg-gray-800`) and
slightly stronger border (`border-gray-300 dark:border-gray-500`) so it reads clearly as a
button rather than styled text. Hover state adds a light fill (`hover:bg-gray-50`). This
keeps it visually secondary to "+ Add Member" while being clearly clickable.
- [ ] "Import Spreadsheet" visually reads as a button (not just text)
- [ ] It is clearly secondary to "+ Add Member" (outlined, no dark fill)
- [ ] Hover state visible on desktop

**Mobile header/action layout polish (final 21I-E adjustment):**
On mobile, the action buttons now appear in their own full-width stacked section below the
MEMBERS heading and description instead of being squeezed into a narrow right column. On
desktop (md+) the original compact side-by-side layout is preserved exactly.
- [ ] Mobile: "MEMBERS" heading + description on top, then full-width "+ Add Member" button, then full-width "Import Spreadsheet" below it
- [ ] Mobile: buttons have comfortable tap targets (py-2.5, full-width)
- [ ] Desktop: heading/description on left, two compact stacked buttons on right (unchanged)
- [ ] Sort chips appear below the action buttons on both mobile and desktop

---

## Checkpoint 21K-B — Button Visual Design Polish

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### What changed

Visual-only polish to the shared button style system. No logic, server actions,
or form behavior changed. No new packages.

### CSS changes (`src/app/globals.css`)

**All shared button classes: radius unified to `rounded-xl` (0.75rem, 12→16px)**

Previously `ct-button-primary/secondary/danger/ghost` used `rounded-lg` (12px)
while all sheet buttons used `rounded-xl` (16px), making the two systems look
inconsistent at the same resolution. All shared classes now use `rounded-xl`.

**`ct-button-primary` — hover behavior replaced**

Previous: `transform: translateY(-2px)` on hover (known flicker risk — same root
cause as the `/events` card flicker fixed in Phase 21J-A).

New: `filter: brightness(1.08)` + shadow deepening on hover. Active state uses
`filter: brightness(0.97) + scale(0.98)`. No vertical movement.

**`ct-button-secondary` — resting shadow added**

Added `box-shadow: 0 1px 2px 0 rgba(0,0,0,0.05)` at rest; deepens slightly on
hover. Makes the button visually distinct from flat page background.

**`ct-button-danger` — hover adds subtle red shadow tint**

`box-shadow: 0 2px 4px -1px rgba(220,38,38,0.15)` on hover reinforces the danger
signal without being aggressive.

**`ct-button-ghost` — radius only; no other change**

**New: `ct-button-neutral`**

Captures the dominant sheet primary CTA pattern (`bg-gray-900` / dark `bg-gray-100`)
that was repeated verbatim in 8+ places. Provides gray-900/gray-100 fill, hover
darkening, active scale, focus ring, and disabled opacity. Compose with padding and
font-size externally.

### Component changes

| File | What changed |
|---|---|
| `AddMemberSheet.tsx` | "Done" and "Add Member" / "Save Changes" buttons → `ct-button-neutral` |
| `ImportMembersSheet.tsx` | "Choose CSV file", "Import N Members", "Done" buttons → `ct-button-neutral` |
| `InviteSheet.tsx` | "Copy" button and the non-admin "Generate Link" branch → `ct-button-neutral` |

The conditional amber/gray Generate button in InviteSheet preserves the amber styling
for admin invites; only the `bg-gray-900` branch uses `ct-button-neutral`.

### QA checklist

**Shared CSS class behavior:**
- [ ] `ct-button-primary` hover: brightness increases, shadow deepens — NO vertical movement
- [ ] `ct-button-primary` active: slight brightness dim + scale(0.98) press
- [ ] `ct-button-primary` radius: `rounded-xl` (larger than before)
- [ ] `ct-button-secondary` resting: subtle shadow visible against white background
- [ ] `ct-button-secondary` hover: accent border/text + light bg fill + shadow deepens
- [ ] `ct-button-danger` hover: subtle red shadow tint appears
- [ ] All classes: disabled = opacity 0.4, cursor not-allowed
- [ ] Dark mode: all hover states readable

**`ct-button-neutral` (new):**
- [ ] Light mode: gray-900 fill, white text
- [ ] Dark mode: gray-100 fill, gray-900 text
- [ ] Hover: slightly darker (gray-800) in light / slightly lighter (gray-200) in dark
- [ ] Active: scale(0.98) press
- [ ] Disabled: opacity 0.4

**Sheet component buttons:**
- [ ] AddMemberSheet "Add Member" CTA looks visually identical to before (same gray-900 fill)
- [ ] AddMemberSheet "Done" looks identical
- [ ] ImportMembersSheet "Choose CSV file", "Import N Members", "Done" look identical
- [ ] InviteSheet "Copy" button looks identical
- [ ] InviteSheet non-admin "Generate Link" button looks identical
- [ ] InviteSheet admin "Generate Admin Invite" button still uses amber (not neutral)

**Existing button usages (should be unaffected except improved styling):**
- [ ] Sign-in form `ct-button-primary w-full` looks correct (radius slightly larger)
- [ ] Profile edit save button looks correct
- [ ] Admin settings buttons look correct
- [ ] Admin events `ct-button-secondary` looks correct
- [ ] Theme toggle `ct-icon-button` unchanged (not modified in this phase)
- [ ] Notification bell `ct-icon-button` unchanged

**No regressions:**
- [ ] No button hover causes card boundary flicker
- [ ] No layout shifts from radius change (border-radius is purely cosmetic)
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21J-C — Admin Member Responsive Overlays

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### Root cause

`AddMemberSheet` and `InviteSheet` both used hardcoded `ct-sheet-enter fixed bottom-0
left-0 right-0` containers — always a mobile bottom sheet regardless of viewport.
`ImportMembersSheet` was already using `ResponsiveSheet` (converted during Phase 21I-E).

### What changed

Both `AddMemberSheet` and `InviteSheet` now use `<ResponsiveSheet variant="modal">`.

- Mobile (< 768px): existing bottom-sheet behavior preserved. Handle pill and "Close"
  text button shown via `md:hidden`.
- Desktop (≥ 768px): centered modal with `ct-modal-enter` animation, × close button
  (top-right), backdrop click closes, Escape key closes.

Same pattern used in Phase 21J-B for EventDetailSheet, CreateEventSheet, etc.

### Files changed

| File | Change |
|---|---|
| `src/app/(app)/admin/members/AddMemberSheet.tsx` | Added `ResponsiveSheet` import; replaced hardcoded container with `<ResponsiveSheet variant="modal">`; handle + Close hidden on desktop |
| `src/app/(app)/admin/members/InviteSheet.tsx` | Same |
| `src/app/(app)/admin/members/ImportMembersSheet.tsx` | Already used `ResponsiveSheet` — no change |

No database changes. No logic changes. No form behavior changes.

### QA checklist

**Mobile (< 768px) — behavior preserved:**
- [ ] "+ Add Member" opens as bottom sheet, slides up from bottom
- [ ] "Edit" roster member opens as bottom sheet
- [ ] Handle pill visible on mobile
- [ ] "Close" text button visible on mobile
- [ ] "Send Invite" opens as bottom sheet
- [ ] All form inputs, validation, and submission unchanged

**Desktop (≥ 768px) — new behavior:**
- [ ] "+ Add Member" opens as centered modal (not bottom pull-up)
- [ ] Handle pill NOT visible on desktop
- [ ] "Close" text button NOT visible on desktop (× provided by ResponsiveSheet)
- [ ] × close button visible top-right on modal
- [ ] Clicking backdrop closes modal
- [ ] Escape key closes modal
- [ ] "Edit" roster member opens as centered modal
- [ ] "Send Invite" opens as centered modal
- [ ] Form fields, role selector, notes all visible and functional in modal
- [ ] Success state ("Member Added") appears correctly in modal
- [ ] "Add Another" / "Done" buttons work in modal

**Import Spreadsheet (unchanged):**
- [ ] Already uses ResponsiveSheet — still opens as desktop modal
- [ ] Mobile still bottom sheet

**No regressions:**
- [ ] Add Member form submission (add_roster_member) still works
- [ ] Edit Member form submission (update_roster_member) still works
- [ ] Invite generation still works
- [ ] Import CSV flow unchanged
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21M — Account Menu and Navigation Cleanup

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### What changed

Navigation label "Profile" renamed to "Account" across all surfaces. Desktop header
gets a new account dropdown menu (initials avatar button). Mobile uses the renamed
BottomNav tab to reach /profile directly; no header dropdown on mobile.

### Navigation label changes

- SideNav (desktop): "Profile" → "Account"
- BottomNav (mobile): "Profile" → "Account"
- Profile page Header screenTitle: "Profile" → "Account"
- Back-links in notifications, security, help, admin/members: "← Back to Profile" → "← Back to Account"

### Account menu (desktop only)

- Initials avatar button added as the rightmost header control (after ThemeToggle + NotificationBell)
- Hidden on mobile (`hidden md:block`)
- Initials derived from first_name + last_name; falls back to first letter of email
- Dropdown anchored `fixed top-14 right-4 z-50` using `ct-popover-enter` animation
- Transparent click-away backdrop at z-40; Escape key also closes
- Dropdown shows: name + email (display), Account link, Notifications link, Change Password link, Sign out
- Sign out: calls `supabase.auth.signOut()` on client, then `router.push("/sign-in")`

### Header data change

`Header.tsx` now selects `first_name, last_name` alongside `club_id` from profiles
(same query, just extended select). These are derived into `userInitials`, `userName`,
and passed as plain strings to `AccountMenu` (client component boundary respected).

### Files changed

| File | Change |
|---|---|
| `src/components/AccountMenu.tsx` | **New** — client component: initials button + dropdown |
| `src/components/Header.tsx` | Added AccountMenu import + data fetch + component |
| `src/components/SideNav.tsx` | "Profile" → "Account" label |
| `src/components/BottomNav.tsx` | "Profile" → "Account" label |
| `src/app/(app)/profile/page.tsx` | screenTitle "Profile" → "Account" |
| `src/app/(app)/profile/notifications/page.tsx` | Back-link "Profile" → "Account" |
| `src/app/(app)/profile/security/page.tsx` | Back-link "Profile" → "Account" |
| `src/app/(app)/help/page.tsx` | Back-link "Profile" → "Account" |
| `src/app/(app)/admin/members/page.tsx` | Back-link "Profile" → "Account" |

No database changes. No route changes. No schema changes.

### QA checklist

**Navigation labels:**
- [ ] SideNav (desktop) shows "Account" as the 4th tab, not "Profile"
- [ ] BottomNav (mobile) shows "Account" as the 4th tab, not "Profile"
- [ ] SideNav "Account" tab is active on /profile, /profile/notifications, /profile/security
- [ ] Profile page Header shows "Account" as the screen title
- [ ] /profile/notifications shows "← Back to Account"
- [ ] /profile/security shows "← Back to Account"
- [ ] /help shows "← Back to Account"
- [ ] /admin/members shows "← Back to Account"

**Account menu — desktop (≥ 768px):**
- [ ] Initials avatar button visible in Header, rightmost control
- [ ] Initials show correctly (first+last initials, or first initial, or email initial)
- [ ] Clicking initials opens the dropdown
- [ ] Dropdown shows user's name (if set) and email
- [ ] "Account" link navigates to /profile
- [ ] "Notifications" link navigates to /profile/notifications
- [ ] "Change Password" link navigates to /profile/security
- [ ] "Sign out" signs out and redirects to /sign-in
- [ ] Clicking outside the dropdown closes it
- [ ] Pressing Escape closes the dropdown
- [ ] Dropdown uses ct-popover-enter animation

**Mobile (< 768px):**
- [ ] No account avatar button visible in Header on mobile
- [ ] BottomNav "Account" tab navigates to /profile
- [ ] Sign out still works from /profile page (existing SignOutButton unchanged)

**Regressions:**
- [ ] ThemeToggle still works
- [ ] NotificationBell still works
- [ ] /profile page content unchanged
- [ ] /profile/notifications content unchanged
- [ ] /profile/security content unchanged
- [ ] All authenticated routes still protected
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21N-A — Date Navigation + Admin Events Fixes

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### What changed

Three improvements with no database changes:
1. `/calendar` date navigation — jump to any future or past date
2. `/calendar` — "Manage events ↗" link for admin/pro
3. `/admin/events` — back-link fix, "+ Create Event" button

### Calendar date navigation

**Date pill re-centering:** `datePills` memo now centers on `selectedDate` (±6 days)
instead of being fixed relative to today. Changing the date updates the visible pill range.

**Today Today button:** Appears when not viewing today. Click → jumps back to today
and re-centers the strip.

**Date picker:** Native `<input type="date">` added to the right of the pill strip
(in a fixed, non-scrolling area separated by a border). Value is bound to `selectedISO`
(club-timezone YYYY-MM-DD). On change, converts to UTC noon and sets `selectedDate`.
Works on desktop and mobile.

**"Manage events ↗" link:** Subtle text link added above the FAB buttons (admin/pro
only). Links directly to `/admin/events` without navigating through Account → Admin.

### Admin events fixes

**Back-link:** "← Back to Profile" → "← Back to Account"

**Courts data:** `page.tsx` now fetches courts (active, ordered) in parallel with the
club query. Passed as `courts` + `clubId` props to `AdminEventsClient`.

**+ Create Event button:** Visible at the top of the events list. Opens existing
`CreateEventSheet` with the club's courts, timezone, and clubId. On creation success,
calls `router.refresh()` to reload the server-rendered event list.

### Files changed

| File | Change |
|---|---|
| `src/app/(app)/calendar/CalendarShell.tsx` | `datePills` re-centered on selectedDate; added `selectedISO` memo; date strip restructured with Today button + date input on right; "Manage events ↗" link above FABs |
| `src/app/(app)/admin/events/page.tsx` | Back-link fixed; courts + clubId fetched and passed down |
| `src/app/(app)/admin/events/AdminEventsClient.tsx` | Added `courts`, `clubId` props; `creatingEvent` state; `CreateEventSheet` import; "+ Create Event" button + sheet render |

No database changes. No migrations.

### QA checklist

**Calendar date picker:**
- [ ] Native date input visible on the right side of the pill strip
- [ ] Entering a date 30 days in the future renders that day's calendar
- [ ] Pill strip re-centers around the selected date (±6 days visible)
- [ ] Today pill still highlighted in blue when visible in the strip
- [ ] Selected date pill highlighted in accent
- [ ] "Today" button appears when not viewing today
- [ ] Clicking "Today" returns to today and re-centers the strip
- [ ] Mobile: date input is usable (native picker opens on tap)
- [ ] Club timezone applied correctly when jumping to a date

**Admin events access:**
- [ ] "Manage events ↗" link visible on /calendar for admin and pro users
- [ ] "Manage events ↗" is NOT visible for member-role users
- [ ] Clicking it navigates to /admin/events
- [ ] /admin/events shows "← Back to Account" (not "← Back to Profile")

**Create Event from /admin/events:**
- [ ] "+ Create Event" button visible on /admin/events
- [ ] Clicking opens CreateEventSheet (desktop modal / mobile bottom sheet)
- [ ] Event creation works end-to-end
- [ ] After creating, the events list refreshes and shows the new event
- [ ] Sheet closes on cancel without creating an event

**No regressions:**
- [ ] Existing date pill navigation still works (clicking pills changes the date)
- [ ] Slot booking on /calendar still works
- [ ] Event creation via FAB on /calendar still works
- [ ] Maintenance block creation still works
- [ ] EventRosterSheet on /admin/events unchanged
- [ ] /events member list unchanged
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21N-A rev2 — Date Navigation, Manage Events, Past Event Joins, Mobile Account

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### Root causes addressed

1. **Mobile date picker crowding** — The inline `w-28` date input crowded the pill strip on mobile.
2. **Manage Events too subtle** — Was rendered as `text-[10px]` faint text above FABs.
3. **Past event join** — EventDetailSheet had no past-event check; members could theoretically join past events from the calendar.
4. **Mobile AccountMenu** — Was `hidden md:block`; initials button not visible on mobile.

### What changed in this revision

**`CalendarShell.tsx`** — Date navigation redesigned:
- New compact nav bar row (above pill strip): [‹ prev] [Wed, Jul 9 ▲ — date label with hidden input overlay] [next ›] + [Today] + [Manage] for admin/pro
- Clicking the date label triggers the native date picker via `opacity-0` overlay
- Prev/next buttons shift one day at a time
- Today button appears when not viewing today
- `Manage` button is now a proper bordered secondary button (not faint text); admin/pro only
- Removed the old `Manage events ↗` tiny text from the FAB area
- Pill strip kept as-is below the nav bar

**`CreateEventSheet.tsx`** — Date selection expanded:
- Date pills extended from 15 to 60 days (covers ~2 months ahead)
- Date picker input added alongside the date label row; allows direct date entry for dates beyond the visible pills

**`EventDetailSheet.tsx`** — Past event join blocked:
- Added `isPastEvent = new Date(event.starts_at) < new Date()`
- `joinBlockedByPast = isPastEvent && !myPart && !isHost`
- When `joinBlockedByPast`: button shows "Event has passed", is disabled, uses neutral styling
- Members already confirmed can still leave; admin/pro roster management unaffected

**`AccountMenu.tsx`** — Now visible on mobile:
- Removed `hidden md:block`; initials button now shows on all screen sizes
- Dropdown `fixed top-14 right-4 w-56` works correctly on mobile viewports
- BottomNav "Account" tab still links to /profile as before

### Admin/pro booking window — MIGRATION REQUIRED (not implemented)

The booking window restriction is enforced inside two SECURITY DEFINER SQL RPCs:
- `create_reservation` (0047_create_reservation_override_check.sql, line 66–67 and 0037_set_member_status.sql, line 136–137): `if p_starts_at > now() + (v_settings.booking_window_days || ' days')::interval then raise exception 'outside_booking_window'; end if;`
- `create_event` (0037_set_member_status.sql, line 136–137): same check; also `cannot_create_past` at line 290

These RPCs already load `v_profile.role`. A migration could add a role check:
```sql
if v_profile.role = 'member' then
  -- only members are restricted to booking_window_days
  if p_starts_at > now() + (v_settings.booking_window_days || ' days')::interval then
    raise exception 'outside_booking_window';
  end if;
end if;
```

And for past event creation (admin/pro record-keeping):
```sql
if v_profile.role = 'member' then
  if p_starts_at < now() then raise exception 'cannot_create_past'; end if;
end if;
```

**No migration created in this pass. Needs Phase 21N-B migration.**

### QA checklist (revised 21N-A)

**Calendar date navigation:**
- [ ] Nav bar row visible above the pill strip
- [ ] Prev (‹) and Next (›) buttons shift one day at a time
- [ ] Date label shows current selected date (e.g. "Wed, Jul 9")
- [ ] Tapping/clicking the date label opens native date picker
- [ ] Selecting a date from the picker updates the calendar to that day
- [ ] Today button appears when not on today; clicking returns to today
- [ ] Pill strip still works (clicking pills navigates)
- [ ] Mobile: nav bar is compact and does not crowd the grid
- [ ] Desktop: nav bar looks clean

**Manage Events button:**
- [ ] "Manage" button visible in nav bar for admin and pro users
- [ ] "Manage" is NOT visible for member users
- [ ] It is styled as a bordered secondary button (not faint text)
- [ ] Clicking navigates to /admin/events

**Create Event date selection:**
- [ ] Date pills in CreateEventSheet show 60 days (not just 15)
- [ ] Date picker input visible next to the "Date" label
- [ ] Admin can enter a date far in the future via the date picker
- [ ] Existing pill-tap date selection still works

**Past event join prevention:**
- [ ] Clicking a past event on /calendar opens EventDetailSheet
- [ ] If member is NOT already confirmed, button shows "Event has passed" (disabled)
- [ ] If member IS already confirmed, "Leave Event" button still works
- [ ] Admin/pro "View Roster" button still shows for past events
- [ ] "Cancel Event" option still shows for admin/host on past events

**Mobile AccountMenu:**
- [ ] Initials button visible in header on mobile
- [ ] Tapping initials opens the dropdown on mobile
- [ ] Dropdown shows name, email, Account, Notifications, Change Password, Sign out
- [ ] Dropdown width (w-56) does not overflow on narrow screens
- [ ] Sign out from dropdown works on mobile
- [ ] BottomNav "Account" tab still navigates to /profile

**No regressions:**
- [ ] Calendar slot booking unchanged
- [ ] Event creation via FAB unchanged
- [ ] Maintenance block creation unchanged
- [ ] /admin/events Create Event button still works
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21N-A final — Events Consolidation + Calendar Cleanup

**Status: Complete ✓ — pnpm tsc --noEmit and pnpm build pass**

### Final scope of Phase 21N-A

All changes are UI/client-only. No database migrations. No schema changes.

### What changed

**`CalendarShell.tsx`** (date navigation only):
- Removed "Manage Events" link/button from the date nav bar (per product decision)
- Removed unused `Link` import
- Compact prev/label/next date nav bar remains
- Pill strip remains
- FAB unchanged (+ Block, + Event for admin/pro)

**`EventsAdminTabs.tsx`** (new client component):
- Segmented "Upcoming | Manage" control for admin/pro users on `/events`
- Both panels rendered into DOM; `hidden` class toggles visibility
- Preserves `AdminEventsClient` pagination state when switching tabs

**`/events/page.tsx`** (events consolidation):
- For **members**: unchanged — sees the existing upcoming events list
- For **admin/pro**: sees a segmented tab control:
  - **Upcoming tab**: same upcoming event list as members (with join/leave actions)
  - **Manage tab**: `AdminEventsClient` — all events (past + future), roster management, + Create Event button (reuses existing `CreateEventSheet`)
- Admin data fetched in parallel with upcoming events (no extra sequential round-trips)
- `/admin/events` route still works for direct access / old links

**`CreateEventSheet.tsx`** (date selection, from earlier pass):
- Date pills: 15 → 60 days
- Native date picker alongside the Date label

**`EventDetailSheet.tsx`** (past event guard, from earlier pass):
- `isPastEvent` check added
- Join/Waitlist disabled for past events; shows "Event has passed" — member only
- Leave still works if already confirmed

**`AccountMenu.tsx`** (from earlier pass):
- Removed `hidden md:block`; initials button now visible on all screen sizes

### Admin/pro booking-window and past-event creation — DEFERRED (migration required)

Both restrictions are enforced inside SECURITY DEFINER SQL RPCs with no role check:

| RPC | Migration file | Check | Effect |
|---|---|---|---|
| `create_reservation` | 0047 line 66–67 | `outside_booking_window` | All users blocked beyond booking_window_days |
| `create_event` | 0037 line 136–137 | `outside_booking_window` | All users blocked beyond booking_window_days |
| `create_event` | 0037 line 290 | `cannot_create_past` | All users blocked from past events |

**Desired fix (Phase 21N-B migration):** add `if v_profile.role = 'member' then` guards so only members are restricted; admin/pro can schedule beyond the window and create past events for record-keeping.

### /events + /admin/events relationship

- `/events` is now the primary visible Events destination in the nav
- Admin/pro see Upcoming + Manage tabs on `/events`
- `/admin/events` route continues to work (linked from Account → Admin → Events and direct access); not the main visible path

### QA checklist

**`/events` — Member experience (no admin/pro role):**
- [ ] No tabs visible — just the upcoming events list
- [ ] Join / Leave / Waitlist / Accept / Pass actions work as before

**`/events` — Admin/pro experience:**
- [ ] "Upcoming" and "Manage" tab buttons visible at the top
- [ ] Upcoming tab shows upcoming events with join/leave actions
- [ ] Manage tab shows all events (past + future) with roster management
- [ ] Switching tabs preserves pagination state in Manage tab
- [ ] "+ Create Event" button in Manage tab works (opens CreateEventSheet)
- [ ] Creating an event from Manage tab refreshes the list

**`/calendar` date navigation (final):**
- [ ] No "Manage" button visible on the calendar
- [ ] Nav bar visible: [‹] [date label + calendar icon] [›] [Today?]
- [ ] Date label has hover background — clearly clickable
- [ ] Clicking/tapping the date label reliably opens native date picker (via showPicker/click ref)
- [ ] Native date picker can navigate to any future date
- [ ] Prev / Next day buttons work
- [ ] Today button appears only when not on today; clicking returns to today
- [ ] Mobile: NO pill rail below the nav bar
- [ ] Desktop: full-width date column rail (13 equal columns, no overflow)
- [ ] Desktop: selected date shown as circular accent badge inside its column
- [ ] Desktop: today column uses blue text (not a badge) when not selected
- [ ] Desktop: unselected columns have subtle hover fill

**`CreateEventSheet` date selection:**
- [ ] 60 date pills visible (scrollable, covers ~2 months)
- [ ] Date picker input alongside the Date label works

**`EventDetailSheet` past events:**
- [ ] "Event has passed" shown on past events for non-participant members (disabled)
- [ ] Already-confirmed members can still leave past events
- [ ] Admin/pro roster management unaffected for past events

**`AccountMenu` mobile:**
- [ ] Initials button visible in header on mobile
- [ ] Dropdown opens and works on mobile

**`/events` consolidation (final):**
- [ ] Admin/pro sees Upcoming | Manage tab selector + exactly ONE "+ Create Event" button at top
- [ ] "+ Create Event" appears once, to the right of the tab selector, visible on both tabs
- [ ] Manage tab does NOT show a second "+ Create Event" button inside its list
- [ ] "+ Create Event" is NOT visible to member-role users
- [ ] Members see the plain upcoming events list only (no tabs, no create button)
- [ ] Account/Profile page admin section has NO redundant Events link
- [ ] /admin/events direct route still works and shows its own Create Event button

**No regressions:**
- [ ] No React key warnings in browser console (upcomingEventsContent wrapped in div)
- [ ] /admin/events direct access still works (showCreateButton defaults to true)
- [ ] Calendar booking / event creation / block creation unchanged
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

### Phase 21N follow-up: Events Manage tab — planned improvements (not in this branch)

The Manage tab in `/events` currently shows events in reverse chronological order.
Future work should add:

- Sort by date (ascending / descending)
- Filter by event type (clinic, social, league, etc.)
- Filter by status (scheduled / cancelled / past)
- Search by event title
- Date range filter (e.g. "next 30 days", "past events", custom range)

These controls are out of scope for Phase 21N-A and should be implemented in a
dedicated phase once the consolidated `/events` experience is stable.

---

## Checkpoint 21N-B — Admin/Pro Scheduling Rule Migration

**Status: Pending SQL apply — migration written, app changes deployed**

### What changed

| Layer | File | Change |
|-------|------|--------|
| SQL | `create_reservation` (0059) | Booking-window guard now member-only; past-date guard preserved for all |
| SQL | `create_event` (0059) | Past-date guard removed; admins/pros may create past events |
| SQL | `join_event` (0059) | Server-side `event_already_started` guard added |
| App | `CreateEventSheet.tsx` | Removed `min={todayISO}` from date input; removed UI past-date check |
| App | `EventDetailSheet.tsx` | Added `event_already_started` to `mapJoinError` |

### Migration to apply

```
supabase/migrations/0059_admin_pro_scheduling_rules.sql
```

Apply in Supabase SQL Editor (cloud only).

### SQL / RPC QA checklist

**create_reservation — booking-window change:**
- [ ] Member books court within booking window → succeeds (unchanged)
- [ ] Member books court beyond booking window → returns `outside_booking_window` (unchanged)
- [ ] Member books court in the past → returns `cannot_book_past` (unchanged)
- [ ] Admin books court within booking window → succeeds
- [ ] Admin books court beyond booking window (e.g. 60 days out when window = 14) → succeeds (new)
- [ ] Admin books court in the past → returns `cannot_book_past` (unchanged; still blocked)
- [ ] Pro books court beyond booking window → succeeds (new)
- [ ] Pro books court in the past → returns `cannot_book_past` (unchanged; still blocked)
- [ ] Admin beyond-window booking still enforces operating hours → `outside_operating_hours` if applicable
- [ ] Admin beyond-window booking still enforces court validation → `court_not_found` if court invalid
- [ ] Conflict detection still fires for overlapping admin bookings → `23P01`

**create_event — past-date change:**
- [ ] Admin creates event with `starts_at` 7 days in the past → succeeds, event row created
- [ ] Pro creates event with `starts_at` 7 days in the past → succeeds, event row created
- [ ] Admin creates event 120 days in the future → succeeds (booking window never applied to events)
- [ ] Admin creates event with invalid duration (`ends_at <= starts_at`) → returns `invalid_duration`
- [ ] Member calling `create_event` directly → returns `insufficient_role` (unchanged)
- [ ] Past event creation: court conflict still detected if a confirmed reservation overlaps → `23P01`
- [ ] Past event: no host participant row inserted (Phase 21I-D behavior preserved)
- [ ] Past event: `events.created_by` correctly records the creator's `auth.uid()`

**join_event — past-date guard:**
- [ ] Member joins a future event → succeeds (unchanged)
- [ ] Member calls `join_event` directly on a past event → returns `event_already_started` (new)
- [ ] Waitlist still works for future full events (unchanged)
- [ ] `already_joined` still returned if caller is already confirmed/waitlisted (unchanged)
- [ ] Notification sent on confirmed join (unchanged)
- [ ] No notification sent on waitlist join (unchanged)

### Application UI QA checklist

**Create Event — past date selection:**
- [ ] Admin opens Create Event sheet → date input has no `min` constraint (can type a past date)
- [ ] Admin types a past date in the date input → sheet accepts it, moves to step 3 without showing "Events cannot be scheduled in the past."
- [ ] Admin submits a past event → RPC succeeds; `onCreated` fires; event appears on calendar for that date
- [ ] Admin submits a future event beyond 60-day pill strip using date input → succeeds (no regression)
- [ ] Pro: same two checks as admin above
- [ ] Date pill strip still starts from today (past dates not in pills; accessible via text input only)
- [ ] Duration validation still works (short events, custom duration field)

**Create Maintenance Block — no change expected:**
- [ ] Admin creates a future maintenance block → succeeds (unchanged)
- [ ] Admin attempts a past maintenance block via the sheet → UI still shows "Maintenance blocks cannot be scheduled in the past." and does not submit
- [ ] No changes visible to the maintenance block sheet UI

**Event join / past event:**
- [ ] Member views a past event in EventDetailSheet → "Event has passed" shown on the join button (UI block unchanged)
- [ ] Member views a past event → join button is disabled
- [ ] If somehow the RPC is reached for a past event → frontend shows "This event has already started." (new error mapping)

**Member court booking — no regression:**
- [ ] Member taps a future slot within the booking window → booking modal appears, booking succeeds
- [ ] Member taps a past time slot in CalendarShell → slot is grayed out and unclickable (unchanged)
- [ ] Member attempts to book a slot beyond the booking window → sheet shows "That date is outside the booking window." (unchanged)

**Admin court booking — new capability:**
- [ ] Admin taps a future slot beyond the booking window → booking modal appears, booking succeeds
- [ ] Admin taps a past time slot in CalendarShell → slot still grayed out (cannot create reservations in the past even as admin)

### /events post-create refresh and tab-switch (Phase 21N-B follow-up fix)

After creating an event from the `/events` admin/pro view:

- [ ] Create Event sheet closes immediately on success
- [ ] View switches to the **Manage** tab automatically (no manual tab click needed)
- [ ] The newly created event appears in the Manage list **without a manual browser refresh**
- [ ] A past event created from `/events` → appears in Manage (not Upcoming), without refresh
- [ ] A future event created from `/events` → appears in Manage list, without refresh
- [ ] The Upcoming tab still shows future events correctly when switching back
- [ ] `/admin/events` direct route: Create Event still works and list updates on close (unchanged)
- [ ] No duplicate "+ Create Event" button visible on `/events` for admin/pro

### No regressions expected in:
- [ ] `cancel_event` behavior (unchanged)
- [ ] `leave_event` / waitlist promotion (unchanged)
- [ ] Admin participant add/remove (unchanged; uses `admin_add_participant`, not `join_event`)
- [ ] Maintenance block creation (future only; SQL and UI unchanged)
- [ ] Notification preferences and delivery (unchanged)
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21N-B1 — Mobile Calendar Date Picker Reliability

**Status: Pending QA — updated by 21N-B2 (hybrid fix)**

### What changed (21N-B1 + 21N-B2)

**21N-B1:** Replaced the old `w-0 h-0 pointer-events-none` hidden-input + `showPicker()`
button with a transparent overlay input (`absolute inset-0 opacity-0`). Mobile Safari
started working because the tap lands directly on the native input.

**21N-B2 (desktop regression fix):** On desktop (Safari especially), the opacity-0 overlay
receives the click on the input's text-field area, which focuses the input but does not
open the picker popover. Fixed with a hybrid pointer-type approach:

- **Coarse pointer (`@media (pointer: coarse)`) — touch devices:** Keeps the overlay input
  pattern from 21N-B1. The user's tap lands directly on the native `<input type="date">`.
  No JS intermediary.
- **Fine pointer (`@media (pointer: fine)`) — mouse/trackpad:** Visible `<button>` renders
  the date label and icon at any viewport width (including desktop in narrow/responsive
  mode). On click, calls `dateInputRef.current?.showPicker()` with a `try/catch` fallback
  to `.click()`. `showPicker()` is the reliable desktop API.

Behavior is pointer-type based, not viewport-width based, so desktop browser in narrow
responsive mode uses the fine-pointer path (button + showPicker) correctly.

| File | Change |
|------|--------|
| `CalendarShell.tsx` (21N-B1) | Removed `datePickerRef` and hidden input; replaced `<button>` with overlay-input `<div>` |
| `CalendarShell.tsx` (21N-B2) | Added `dateInputRef`; split date label into `[@media(pointer:fine)]:hidden` overlay and `hidden [@media(pointer:fine)]:flex` button+ref |

### QA checklist

**Mobile (iOS Safari, Android Chrome):**
- [ ] Tap the date label on `/calendar` → native date picker opens reliably
- [ ] Select a date → calendar updates to that date; no timezone drift
- [ ] Today's date shown correctly in local timezone after selection
- [ ] Hover (n/a on mobile) — no visual glitch from `has-[input:hover]` rule

**Desktop — full width (Chrome, Safari, Firefox):**
- [ ] Click the date label → native date picker opens (via `showPicker()`)
- [ ] Hover over the date label → subtle background highlight appears
- [ ] Select a date → calendar updates to that date; no timezone drift

**Desktop — narrow/responsive viewport (DevTools mobile emulation):**
- [ ] Click the date label → native date picker opens (still uses fine-pointer path)
- [ ] Behavior identical to full-width desktop — button + showPicker(), not overlay
- [ ] Hover highlight visible

**Both environments — no timezone drift:**
- [ ] Date selection sets `new Date(value + "T12:00:00Z")` — UTC noon ensures the calendar date is preserved in any timezone
- [ ] Navigating forward/back from a picker-selected date stays on the correct date

**No regressions:**
- [ ] Prev (‹) and Next (›) day buttons work
- [ ] Today button appears when not on today; disappears when on today
- [ ] Desktop date rail (column strip) still shows and selects dates
- [ ] Mobile date rail still hidden (only nav bar visible on mobile)
- [ ] Bookings, events, and maintenance blocks still render on the grid
- [ ] Admin/pro Create Event and Create Block buttons unchanged
- [ ] Member court booking slot tap → booking sheet opens unchanged
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21N-C1 — Events Manage Filters and Sorting

**Status: Pending QA**

### What changed

Added client-side status, date, and sort filters to the Manage tab on `/events` for admin/pro users.

| File | Change |
|------|--------|
| `src/app/(app)/admin/events/AdminEventsClient.tsx` | Added `StatusFilter`, `DateFilter`, `SortOrder` types; added three filter state variables; added `visibleEvents` derived list (filter then sort, no mutation); added compact filter bar (three pill groups) above the card list; added filtered-empty state; kept Load More offset on raw `events.length`; filter state NOT reset by the RSC sync `useEffect` |

No migrations. No SQL changes. No RPC changes. No schema changes. No changes to member view, `/calendar`, scheduling rules, or date picker.

### Filter defaults

| Control | Default | Options |
|---------|---------|---------|
| Status | `scheduled` | `scheduled`, `cancelled`, `all` |
| Date | `all` | `all`, `upcoming`, `past` |
| Sort | `desc` (Newest) | `desc`, `asc` |

### How Load More works with filters

`fetchMoreAdminEvents(events.length)` always uses the raw loaded count as offset — not `visibleEvents.length`. This means pagination is correct regardless of the active filter. New events appended to `events` state automatically flow through the filter/sort computation on the next render.

### QA checklist

**Default filter state:**
- [ ] On navigating to Manage tab, status filter shows "Scheduled" as active
- [ ] On navigating to Manage tab, date filter shows "All dates" as active
- [ ] On navigating to Manage tab, sort shows "Newest" as active
- [ ] Default view shows only scheduled events (past + future) newest first
- [ ] Cancelled events are NOT visible in the default view

**Status filter:**
- [ ] Tapping "Cancelled" shows only cancelled events
- [ ] Tapping "All" shows both scheduled and cancelled events
- [ ] Tapping "Scheduled" re-hides cancelled events

**Date filter:**
- [ ] Tapping "Upcoming" shows only events with starts_at >= now
- [ ] Tapping "Past" shows only events with starts_at < now
- [ ] Tapping "All dates" shows past and future events together

**Sort order:**
- [ ] Tapping "Oldest" sorts ascending (earliest at top)
- [ ] Tapping "Newest" sorts descending (most recent at top)
- [ ] Sort applies to the filtered result (not the raw events array)

**Combined filters:**
- [ ] Upcoming + Scheduled: only future scheduled events
- [ ] Past + Cancelled: only past cancelled events
- [ ] Past + All (status) + Oldest: all past events, oldest first
- [ ] All (dates) + Cancelled + Newest: all cancelled events, newest first

**Empty states:**
- [ ] True-empty (no events loaded at all): shows "No events yet." — unchanged
- [ ] Filtered-empty on "Upcoming" date filter: shows message mentioning Load more
- [ ] Filtered-empty on "Cancelled" status filter: shows "No cancelled events in the loaded results."
- [ ] Filtered-empty on other combos: shows "No events match these filters."
- [ ] Filter bar still visible during filtered-empty state (controls remain accessible)

**Load more:**
- [ ] "Load more" button appears when server reports hasMore
- [ ] Clicking "Load more" appends new events to the raw list
- [ ] Newly appended events pass through active filters automatically
- [ ] Load more offset is correct even with filters active (uses raw events.length)
- [ ] "Load more" disappears when all events are loaded

**Filter state persistence:**
- [ ] Filter settings persist when switching Manage → Upcoming → back to Manage (both panels stay mounted via CSS hidden)
- [ ] RSC refresh after creating an event does NOT reset filter state
- [ ] Newly created event appears in Manage if it matches the active filters
- [ ] If newly created event does not match active filters, it does not appear until filters are changed (expected)

**Member `/events` unaffected:**
- [ ] Members see only the Upcoming events list — no tabs, no filters, no create button
- [ ] Member join / leave / waitlist actions work unchanged
- [ ] Member view shows only future scheduled events

**`/calendar` unaffected:**
- [ ] Court booking unchanged
- [ ] Admin/pro event creation from calendar unchanged
- [ ] Mobile date picker overlay (21N-B1) unchanged

**`/admin/events` direct route:**
- [ ] `/admin/events` renders AdminEventsClient with `showCreateButton={true}`
- [ ] Filter controls appear on `/admin/events` as well (shared component)
- [ ] Create Event button on `/admin/events` still works
- [ ] Load more still works on `/admin/events`

**No regressions:**
- [ ] Roster button opens EventRosterSheet for scheduled events
- [ ] Roster changes (add/remove participant or guest) update occupancy counts in the card
- [ ] Roster button absent on cancelled event cards
- [ ] `cancel_event` behavior unchanged
- [ ] Phase 21N-B scheduling rules unchanged (admin/pro booking window, past-event create, join_event past guard)
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓


---

## Checkpoint 21N-D — Events Search and Event Type Filters (Revised)

**Status: Pending QA**

### What changed

Added client-side search and event type filtering to both the admin/pro Manage tab and the member Upcoming list on `/events`. Revised in 21N-D-rev to replace admin pill-button groups with a cleaner dropdown toolbar and improve search input styling on both surfaces.

| File | Change |
|------|--------|
| `src/app/(app)/events/EventsUpcomingClient.tsx` | **New.** Client component owning the Upcoming events list. Search input + event type pills + filtered date-grouped cards. Receives server actions as props from RSC parent. Search input styled with border, white bg, and shadow for visibility. |
| `src/app/(app)/admin/events/AdminEventsClient.tsx` | Added `searchQuery` and `eventTypeFilter` state. Added `eventTypeOptions` derivation. Revised filter toolbar: search input (full-width, top row) + four compact `<select>` dropdowns (Status / When / Sort / Type) replacing the previous pill-button groups. Shared `selectClass` constant keeps all four dropdowns visually consistent. |
| `src/app/(app)/events/page.tsx` | Removed `RawEventRow` type and `upcomingEventsContent` RSC block. Replaced with `<EventsUpcomingClient />` receiving serialized props (including server actions). Used for admin Upcoming tab and member-only view. |

No migrations. No SQL changes. No RPC changes. No schema changes.

### Admin Manage filter toolbar layout

```
[Search events…                          ×]
[Scheduled ▾] [All dates ▾] [Newest ▾] [Type ▾]
```

Search is full-width on the first row. The four dropdowns sit below in a `flex-wrap` row, so they reflow naturally on narrow screens.

### Dropdown options

| Dropdown | Options | Default |
|----------|---------|---------|
| Status | Scheduled · Cancelled · All statuses | Scheduled |
| When | All dates · Upcoming · Past | All dates |
| Sort | Newest · Oldest | Newest |
| Type | All types · [types in loaded events] | All types |

### Filter pipeline — Admin Manage

Order of application: **status → date → event type → search → sort**

Load More offset always uses `events.length` (raw count), not `visibleEvents.length`. Filter state is NOT reset on RSC refresh.

### Member Upcoming filter layout

```
[Search events…                          ×]
[All] [Clinic] [Social] [League]   ← type pills, shown only when events have types
```

Member event type options are derived from the upcoming scheduled events passed in as props — no admin-only events bleed in.

### QA checklist

**Admin Manage — search input:**
- [ ] Search input appears full-width above the dropdowns
- [ ] Input has a visible border and white (light mode) / dark background (dark mode)
- [ ] Placeholder "Search events…" is legible
- [ ] Input does not look disabled or faint
- [ ] Typing a partial title filters cards case-insensitively
- [ ] × button appears when search is non-empty; clicking it clears the input
- [ ] Search combines correctly with all four dropdown filters

**Admin Manage — Status dropdown:**
- [ ] Default shows "Scheduled"; list renders Scheduled / Cancelled / All statuses
- [ ] Selecting "Cancelled" shows only cancelled events (same as before)
- [ ] Selecting "All statuses" shows both scheduled and cancelled events
- [ ] Returning to "Scheduled" re-hides cancelled events
- [ ] Dropdown matches visual style of other three controls

**Admin Manage — When dropdown:**
- [ ] Default shows "All dates"; list renders All dates / Upcoming / Past
- [ ] Selecting "Upcoming" shows only events with starts_at ≥ now
- [ ] Selecting "Past" shows only events with starts_at < now
- [ ] Returning to "All dates" restores all events

**Admin Manage — Sort dropdown:**
- [ ] Default shows "Newest"; list renders Newest / Oldest
- [ ] Selecting "Oldest" sorts ascending (earliest at top)
- [ ] Sort applies after all other filters

**Admin Manage — Type dropdown:**
- [ ] Hidden until at least one loaded event has an event_types value
- [ ] Default shows "All types"
- [ ] List shows all unique types from ALL loaded events, sorted alphabetically
- [ ] Selecting a type filters to that type only
- [ ] Returning to "All types" shows all events
- [ ] After Load More, new event types appear immediately in the dropdown

**Admin Manage — combined filters:**
- [ ] Scheduled + Upcoming + type X + search: narrows correctly
- [ ] Cancelled + All dates + search: narrows to cancelled events matching search
- [ ] Filter state persists when switching Manage → Upcoming → back to Manage (CSS hidden)
- [ ] RSC refresh (after creating event) does NOT reset any filter or search state
- [ ] Newly created event appears if it matches active filters

**Admin Manage — Load More with filters:**
- [ ] Clicking Load More appends events to raw list
- [ ] Offset is always `events.length` (raw), never `visibleEvents.length`
- [ ] Newly loaded events flow through all active filters automatically
- [ ] New event types from loaded batch immediately appear in Type dropdown

**Admin Manage — empty states:**
- [ ] True empty (no events at all): shows "No events yet." — unchanged
- [ ] Search empty: `No events match "<query>".` + "Clear search & type filter" link
- [ ] Type-only empty: "No events of this type in the loaded results." + "Clear search & type filter" link
- [ ] When=Upcoming empty: "No upcoming events in the loaded results. Tap Load more…"
- [ ] Status=Cancelled empty: "No cancelled events match the current filters."
- [ ] Other combo empty: "No events match these filters."

**Member Upcoming — search:**
- [ ] Search input is full-width, has visible border and white/dark background
- [ ] Input does not look faint or disabled
- [ ] Typing filters events across all date groups
- [ ] Date groups with zero matching events are hidden entirely (header too)
- [ ] × clears search and restores all date groups
- [ ] Filtered-empty: "No events match your search." + "Clear filters" link

**Member Upcoming — event type pills:**
- [ ] Pills shown only when at least one upcoming event has an event_types value
- [ ] Types derive from UPCOMING scheduled events only (not admin events)
- [ ] "All" pill active by default (dark background)
- [ ] Tapping a type pill filters and highlights it in the type's color
- [ ] Re-tapping the active type deselects it (returns to All)
- [ ] Combined search + type filter works

**Member Upcoming — role restrictions:**
- [ ] Members see NO Manage tab
- [ ] Members see NO "+ Create Event" button
- [ ] Members see NO Status / When / Sort dropdowns
- [ ] Members see only upcoming scheduled events (server-filtered)
- [ ] Join / Leave / Waitlist / Accept / Pass / Rejoin actions still work

**`/admin/events` direct route:**
- [ ] Renders AdminEventsClient with `showCreateButton={true}`
- [ ] Search input present and functional
- [ ] All four dropdown controls present (Status, When, Sort, and Type when applicable)
- [ ] Create Event button still works
- [ ] Load more still works

**No regressions:**
- [ ] Calendar unaffected; date picker (21N-B1/C) unaffected
- [ ] Phase 21N-B scheduling rules unchanged
- [ ] Roster button opens EventRosterSheet; changes update occupancy counts
- [ ] Roster button absent on cancelled event cards
- [ ] Only one "+ Create Event" button visible at a time in admin/pro view
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21O-A — Event Archive Schema and RPCs

**Status: Pending migration apply + QA**

### What changed

Added archive/unarchive capability to the `events` table. No app UI yet (comes in 21O-B). No member-visible changes yet (comes in 21O-C).

| Object | Change |
|--------|--------|
| `events.archived_at` | New column — `timestamptz`, nullable. Null = not archived. |
| `events.archived_by` | New column — `uuid`, FK to `profiles(id) ON DELETE SET NULL`. |
| `events_club_starts_at_not_archived_idx` | Partial index on `(club_id, starts_at desc) WHERE archived_at IS NULL` — speeds up the default non-archived query. |
| `events_club_archived_at_idx` | Partial index on `(club_id, archived_at, starts_at desc) WHERE archived_at IS NOT NULL` — speeds up "show archived" queries. |
| `archive_event(p_event_id uuid)` | New SECURITY DEFINER RPC. Sets `archived_at`, `archived_by`, `updated_at`. Writes audit log. No notifications. No linked-row changes. |
| `unarchive_event(p_event_id uuid)` | New SECURITY DEFINER RPC. Clears `archived_at` and `archived_by`. Writes audit log. No notifications. No linked-row changes. |

Migration file: `supabase/migrations/0060_archive_event.sql`

No app files modified. No SQL applied yet.

### Permission model

| Role | archive_event | unarchive_event |
|------|--------------|-----------------|
| admin | Any event in club | Any archived event in club |
| pro | Only `events.created_by = self` | Only `events.created_by = self` |
| member | `insufficient_role` | `insufficient_role` |

### Archive guards

| Guard | Condition | Error |
|-------|-----------|-------|
| Already archived | `archived_at IS NOT NULL` | `already_archived` |
| Future scheduled | `status = 'scheduled' AND starts_at > now()` | `event_not_past` |

Past scheduled events and cancelled events (including future-dated cancellations) are always archivable.

### QA checklist

**Migration prerequisites:**
- [ ] Apply `0060_archive_event.sql` in Supabase SQL Editor
- [ ] Confirm no SQL errors during apply

**Schema — columns present:**
- [ ] `events.archived_at` column exists (timestamptz, nullable)
- [ ] `events.archived_by` column exists (uuid, nullable, FK to profiles)
- [ ] Existing events unaffected — all have `archived_at = null`

**Schema — indexes present:**
- [ ] `events_club_starts_at_not_archived_idx` exists as a partial index (`WHERE archived_at IS NULL`)
- [ ] `events_club_archived_at_idx` exists as a partial index (`WHERE archived_at IS NOT NULL`)

**archive_event — permissions:**
- [ ] Unauthenticated call raises `not_authenticated`
- [ ] Member call raises `insufficient_role`
- [ ] Pro call on an event they did NOT create raises `insufficient_role`
- [ ] Pro call on their own past/cancelled event succeeds
- [ ] Admin call on any past/cancelled event succeeds

**archive_event — guards:**
- [ ] Calling on an already-archived event raises `already_archived`
- [ ] Calling on a future scheduled event raises `event_not_past`
- [ ] Calling on a past scheduled event (starts_at < now, status = scheduled) succeeds
- [ ] Calling on a cancelled event (any starts_at) succeeds

**archive_event — data changes:**
- [ ] `archived_at` is set to approximately now()
- [ ] `archived_by` is set to the calling user's profile id
- [ ] `updated_at` is updated
- [ ] `event_participants` rows are NOT changed
- [ ] `event_guests` rows are NOT changed
- [ ] `reservations` rows are NOT changed
- [ ] No notifications inserted

**archive_event — audit log:**
- [ ] One `audit_log` row inserted with `action = 'archive_event'`
- [ ] `target_type = 'event'`, `target_id = p_event_id`
- [ ] `metadata` contains `title`, `starts_at`, `status`

**unarchive_event — permissions:**
- [ ] Unauthenticated call raises `not_authenticated`
- [ ] Member call raises `insufficient_role`
- [ ] Pro call on an archived event they did NOT create raises `insufficient_role`
- [ ] Pro call on their own archived event succeeds
- [ ] Admin call on any archived event succeeds

**unarchive_event — guards:**
- [ ] Calling on a non-archived event raises `not_archived`
- [ ] Calling on an archived event succeeds

**unarchive_event — data changes:**
- [ ] `archived_at` is set back to null
- [ ] `archived_by` is set back to null
- [ ] `updated_at` is updated
- [ ] No linked rows modified
- [ ] No notifications inserted

**unarchive_event — audit log:**
- [ ] One `audit_log` row inserted with `action = 'unarchive_event'`
- [ ] `target_type = 'event'`, `target_id = p_event_id`
- [ ] `metadata` contains `title`, `starts_at`, `status`

**No hard delete:**
- [ ] archive_event does not delete the events row
- [ ] archive_event does not delete event_participants rows
- [ ] archive_event does not delete event_guests rows
- [ ] archive_event does not delete reservations rows

**No regressions:**
- [ ] cancel_event unaffected — still works as before
- [ ] create_event unaffected
- [ ] All admin participant action RPCs unaffected
- [ ] Existing events queries unaffected (columns default to null, no query changes yet)
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

## Checkpoint 21O-B — Admin Archive / Unarchive UI

**Status: Pending QA**

### What changed

Added admin/pro archive and unarchive controls to the Manage tab on `/events` and to `/admin/events`. Added "Show archived" toggle to include archived events in the list.

| File | Change |
|------|--------|
| `src/app/(app)/admin/events/actions.ts` | Added `created_by`, `archived_at`, `archived_by` to `AdminEventRow`. Added `showArchived` param to `fetchMoreAdminEvents` (default false, adds `archived_at IS NULL` filter when false). Added `archiveEventAction` and `unarchiveEventAction` with separate error message maps. Added `revalidatePath` calls. |
| `src/app/(app)/admin/events/AdminEventsClient.tsx` | Added `userId?` prop. Added `showArchived`, `confirmingArchiveId`, `confirmingUnarchiveId`, `archiveError` state. Added `handleToggleShowArchived`, `handleArchive`, `handleUnarchive` handlers. Updated `handleLoadMore` to pass `showArchived`. Added "Show archived" checkbox below dropdown row. Added `Archived` badge, archive/unarchive inline confirmations to event cards. Hidden roster button for archived events. |
| `src/app/(app)/admin/events/page.tsx` | Added `created_by, archived_at, archived_by` to select. Added `.is("archived_at", null)` filter (default). Passes `userId={user.id}`. |
| `src/app/(app)/events/page.tsx` | Added `created_by, archived_at, archived_by` to admin manage query select. Added `.is("archived_at", null)` to admin manage query and member upcoming query. Passes `userId={user.id}` to `AdminEventsClient`. |
| `src/app/(app)/calendar/CalendarShell.tsx` | Added `.is("archived_at", null)` to client-side events fetch so archived past events don't appear when navigating to historical calendar dates. |

No migrations. No SQL applied. No schema changes.

### Archive eligibility (client-side)

| Event state | Archive button | Unarchive button |
|------------|---------------|-----------------|
| Future scheduled, not archived | Hidden | Hidden |
| Past scheduled, not archived | Shown (admin or pro-creator) | Hidden |
| Cancelled, not archived | Shown (admin or pro-creator) | Hidden |
| Any archived | Hidden | Shown (admin or pro-creator, when Show archived = on) |

### Inline confirmation text

**Archive:**
> Archive this event?
> Past event data and roster history will be preserved.
> [Keep] [Archive]

**Unarchive:**
> Unarchive this event?
> This event will return to the default Manage view.
> [Keep archived] [Unarchive]

### Show archived toggle behavior

- Default off: list fetches only events where `archived_at IS NULL` (25-event pages)
- Toggled on: list reloads from offset 0, fetching all events (archived + non-archived)
- Load More always uses current `showArchived` value to keep pages consistent
- Toggling resets the loaded list to the first 25 events (pagination restarts)

### QA checklist

**Archive button visibility:**
- [ ] Future scheduled events show NO Archive button
- [ ] Past scheduled events show Archive button (admin)
- [ ] Cancelled events show Archive button (admin)
- [ ] Admin sees Archive on any eligible event
- [ ] Pro sees Archive only on eligible events they created
- [ ] Pro does NOT see Archive on other pros' events
- [ ] Members see NO Archive button anywhere

**Archive inline confirmation:**
- [ ] Clicking "Archive" on a card shows inline confirmation (no modal)
- [ ] Confirmation text: "Archive this event?" + "Past event data and roster history will be preserved."
- [ ] "Keep" button dismisses confirmation and shows the Archive button again
- [ ] "Archive" button calls the RPC and updates the list
- [ ] Archived event disappears from default Manage view (showArchived = off)
- [ ] Error messages surface inline for: `event_not_past`, `already_archived`, `insufficient_role`
- [ ] Archive button disabled / shows "Archiving…" during pending state

**Unarchive inline confirmation (Show archived = on):**
- [ ] Clicking "Unarchive" on an archived card shows inline confirmation
- [ ] Confirmation text: "Unarchive this event?" + "This event will return to the default Manage view."
- [ ] "Keep archived" button dismisses confirmation
- [ ] "Unarchive" button calls the RPC and updates the list
- [ ] Unarchived event acquires the appropriate status badge (Scheduled or Cancelled)
- [ ] Error message surfaces inline for `not_archived`, `insufficient_role`
- [ ] Unarchive button disabled / shows "Restoring…" during pending state

**Archived badge and visual clarity:**
- [ ] Archived events show BOTH a status badge (Scheduled or Cancelled) AND a separate gray "Archived" badge
- [ ] Archived badge does NOT replace the status badge — both appear as separate pills
- [ ] Archived cards have a subtle ring/border (`ring-1 ring-inset ring-gray-200 dark:ring-gray-600`)
- [ ] Cancelled events are NOT transparent — no `opacity-50`; text is fully readable
- [ ] Archive trigger button is styled as outlined amber (not faint gray text)
- [ ] Unarchive trigger button is styled as outlined blue (not faint gray text)
- [ ] Both buttons look actionable, not like disabled secondary labels

**View dropdown (Active / Archived / All):**
- [ ] Filter bar includes a "View" select with options: Active / Archived / All
- [ ] Default: Active; list shows only non-archived events (`.is("archived_at", null)`)
- [ ] Switching to Archived: list reloads from offset 0, shows only archived events
- [ ] Switching to All: list reloads from offset 0, shows all events (no archived filter)
- [ ] Switching back to Active: list reloads from offset 0, shows only non-archived events
- [ ] View select is in the same row as Status / When / Sort / Type dropdowns
- [ ] Other filters (Status / When / Sort / Type / Search) still work at any View value
- [ ] Pagination state resets to offset 0 on View change

**Load More behavior:**
- [ ] View = Active: Load More fetches next page of non-archived events
- [ ] View = Archived: Load More fetches next page of archived events
- [ ] View = All: Load More fetches next page of all events
- [ ] Offset is always `events.length` (raw), not `visibleEvents.length`
- [ ] Load More button disabled while loading

**Roster button:**
- [ ] Roster button is NOT shown for archived events
- [ ] Roster button still shown for non-archived scheduled events
- [ ] Roster button still absent for cancelled events (existing behavior)

**Member visibility:**
- [ ] Members see NO Archive / Unarchive controls
- [ ] Members see NO "Show archived" checkbox
- [ ] Members see NO Manage tab
- [ ] Member Upcoming excludes archived events (server filter)

**`/admin/events` direct route:**
- [ ] All of the above applies to `/admin/events` (same `AdminEventsClient` component)
- [ ] `showCreateButton={true}` still works alongside archive controls

**Calendar (`/calendar`):**
- [ ] Calendar event blocks do NOT show archived events on any date (including historical dates)
- [ ] Date picker, navigation, and booking behavior unchanged

**No notifications:**
- [ ] Archiving an event does NOT send notifications to participants
- [ ] Unarchiving an event does NOT send notifications to participants

**No data loss:**
- [ ] Archived event's `event_participants` rows are unmodified
- [ ] Archived event's `event_guests` rows are unmodified
- [ ] Archived event's `reservations` rows are unmodified
- [ ] Archived event's `notifications` still reference the event
- [ ] Archived event row itself is preserved — no delete

**Empty-state behavior (filter bar always visible):**
- [ ] Filter bar (including View dropdown) is always visible regardless of events.length
- [ ] View = Active, 0 server results: "No active events found. Switch to Archived to view archived events."
- [ ] View = Archived, 0 server results: "No archived events found."
- [ ] View = All, 0 server results: "No events found."
- [ ] Client filters narrow results to 0 but events loaded: shows appropriate "No events match …" copy
- [ ] Switching View from empty Active state reloads and may reveal events
- [ ] Create Event button remains accessible when the events list is empty (if showCreateButton = true)
- [ ] "Clear search & type filter" link does NOT appear when events.length = 0 (no events to reveal)

**No regressions:**
- [ ] All existing Status / When / Sort / Type / Search filters unaffected
- [ ] Load More offset correct across all View values (Active / Archived / All)
- [ ] Creating an event still works; new event appears in list after refresh
- [ ] Roster mutations (add/remove participant, add/remove guest) unaffected
- [ ] Cancel event behavior unaffected
- [ ] Phase 21N-B scheduling rules unaffected
- [ ] Calendar date picker (21N-B1/C) unaffected
- [ ] pnpm tsc --noEmit ✓ / pnpm build ✓

---

### 21O-C: Archived Event Read-Only Roster UI

**Scope:** UI-only. No SQL changes, no RPC changes, no migrations.

**Files changed:** `EventRosterSheet.tsx`, `EventRosterButton.tsx`, `AdminEventsClient.tsx`.

**View Roster button for archived non-cancelled events**
- [ ] Archived non-cancelled event card shows "View Roster (N)" button in bottom section
- [ ] "View Roster" label is distinct from editable "Roster (N)" label on active events
- [ ] Archived cancelled events show NO roster button (cancelled events never show roster)
- [ ] Active non-cancelled events still show editable "Roster (N)" button
- [ ] Cancelled non-archived events still show NO roster button

**Read-only notice in roster sheet**
- [ ] Tapping "View Roster" on an archived event opens EventRosterSheet
- [ ] Notice banner appears at top of sheet body: "Archived event — roster is read-only."
- [ ] Notice is visible before any participant sections
- [ ] Notice does NOT appear for active (non-archived) events

**Mutation controls hidden in read-only mode**
- [ ] "+ Add Member" button is NOT shown
- [ ] "+ Add Guest" button is NOT shown
- [ ] "Remove" button is NOT shown for any confirmed member row
- [ ] "Remove" button is NOT shown for any roster-linked guest row ("No Account Yet")
- [ ] "Remove" button is NOT shown for any anonymous guest row
- [ ] "Force Confirm" is NOT shown in the Offered section
- [ ] "Expire" is NOT shown in the Offered section
- [ ] "Force Confirm" is NOT shown in the Waitlist section
- [ ] "Offer Spot" is NOT shown in the Waitlist section
- [ ] Attendance toggle buttons (Attended / No-show / Clear) are NOT shown

**Display-only data visible in read-only mode**
- [ ] Section headers are shown (Signed-In Members, Offered, Waitlist, No Account Yet, Guests)
- [ ] Member names are shown in each section
- [ ] Guest names are shown
- [ ] Waitlist position numbers (#1, #2…) are shown
- [ ] Offer expiry timestamps are shown as informational text
- [ ] Total attending count in sheet header is shown
- [ ] Recorded attendance status shown as a static pill (green "Attended" / red "No-show") when set; hidden when null
- [ ] Sheet closes normally (close button / back-drag on mobile)

**Active roster still fully editable**
- [ ] Active non-archived non-cancelled events open editable "Roster (N)"
- [ ] "+ Add Member" visible and functional
- [ ] "+ Add Guest" visible and functional
- [ ] "Remove" visible on confirmed member rows
- [ ] Attendance toggle buttons (Attended / No-show / Clear) visible and functional
- [ ] Force Confirm, Offer Spot, Expire visible in offered/waitlist sections
- [ ] No notice banner in active roster sheet

**Cancel Event action (added alongside read-only roster)**

Card lifecycle per event type:
- [ ] Future scheduled active event shows: Roster (editable) + Cancel Event button — no Archive button
- [ ] Past scheduled active event shows: Roster (editable) + Archive button — no Cancel Event button
- [ ] Cancelled active event shows: Archive button — no Roster button, no Cancel Event button
- [ ] Future scheduled archived event shows: View Roster (read-only) — no Cancel, no Archive (already archived)
- [ ] Past scheduled archived event shows: View Roster (read-only) — no Cancel, no Archive (already archived)
- [ ] Cancelled archived event shows: Unarchive only (separate section) — no Roster, no Cancel, no Archive

Card action row layout:
- [ ] Action footer uses a horizontal flex row: Roster/View Roster on the left, lifecycle actions (Cancel Event / Archive / Unarchive) on the right
- [ ] On narrow widths the row wraps cleanly; no cramped sibling-text appearance
- [ ] When a confirmation is open, it renders full-width (replaces the flex row for that card)
- [ ] Only one confirmation visible at a time across all cards

Cancel Event button:
- [ ] Cancel Event button uses red outline style (border-red-200 text-red-600)
- [ ] Admin sees Cancel Event on any future scheduled non-archived event
- [ ] Pro sees Cancel Event only on future scheduled non-archived events they created
- [ ] Pro does NOT see Cancel Event on other pros' events

Cancel Event inline confirmation:
- [ ] Tapping "Cancel Event" opens inline confirmation (no modal)
- [ ] Confirmation title: "Cancel this event?"
- [ ] Confirmation helper: "Members will be notified and linked court reservations will be cancelled."
- [ ] "Keep event" button dismisses confirmation and shows Cancel Event button again
- [ ] "Cancel Event" confirm button calls cancelEvent action
- [ ] Successful cancel reloads list from offset 0 (event disappears from Scheduled filter, appears in Cancelled filter)
- [ ] Cancel button shows "Cancelling…" during pending state and is disabled
- [ ] Only one inline confirmation visible at a time (opening Cancel closes Archive/Unarchive confirmations, and vice versa)

Cancel Event error handling:
- [ ] `insufficient_role` → "You do not have permission to cancel this event."
- [ ] `event_not_found` / `event_cancelled` → "This event could not be cancelled. It may already be cancelled."
- [ ] Other errors → "Unable to cancel event. Please try again."
- [ ] Error appears inline inside the confirmation block

Cancel Event downstream behavior (via existing cancel_event RPC):
- [ ] Event status becomes "cancelled" in the database
- [ ] Linked court reservations are cancelled
- [ ] Participants receive event_cancelled in-app notifications
- [ ] SMS dispatched to opted-in participants (actor excluded)
- [ ] Email dispatched to opted-in participants (actor excluded)

**Archive/unarchive controls unaffected**
- [ ] Archive inline confirmation still works on eligible non-archived events (past scheduled, cancelled)
- [ ] Unarchive inline confirmation still works on archived events
- [ ] View dropdown (Active / Archived / All) still works
- [ ] Archive button NOT shown on future scheduled events (expected: must cancel first)

**No SQL/migration changes**
- [ ] No new migration files
- [ ] No RPC changes
- [ ] No database schema changes
- [ ] `pnpm tsc --noEmit` ✓
- [ ] `pnpm build` ✓

**Future follow-up (not in this phase)**
~~Add `IF archived_at IS NOT NULL THEN RAISE EXCEPTION 'event_archived'; END IF;` to all 8 admin roster mutation RPCs and `mark_attendance`.~~ → Implemented in Phase 21O-D (migration 0061).

---

## Phase 21O-D — Server-Side Archive Guards for Roster Mutations

**Branch:** `phase-21o-d-archive-roster-rpc-guards`

### Migration 0061 — SQL review checklist (before applying)

> **Do not apply until migration 0060 (`archived_at` column) is live.**

Migration file: `supabase/migrations/0061_archive_roster_guard.sql`

- [ ] File exists at correct path and is numbered 0061
- [ ] All 9 functions use `CREATE OR REPLACE` (idempotent, no DROP needed)
- [ ] `event_archived` guard line (`if v_event.archived_at is not null then raise exception 'event_archived'; end if;`) appears in each function
- [ ] Guard is placed **after** `event_not_found` and `event_cancelled` checks (where applicable), **before** any mutation
- [ ] `mark_attendance` upgraded from `not exists` check to `select * into v_event` to enable row access for guard
- [ ] `mark_attendance` has NO `event_cancelled` guard (intentional — preserved from original)
- [ ] All other function bodies are byte-for-byte identical to their source migrations (0051/0057/0017) except for the inserted guard line
- [ ] Audit log entries, notifications, and waitlist advance calls are all preserved

**Functions guarded (9):**

| Function | Source migration | Guard position |
|---|---|---|
| `admin_add_member` | 0051 | after `event_cancelled` |
| `admin_remove_participant` | 0051 | after `event_cancelled` |
| `admin_force_confirm` | 0051 | after `event_cancelled` |
| `admin_offer_spot` | 0051 | after `event_cancelled` |
| `admin_expire_offer` | 0051 | after `event_cancelled` |
| `admin_add_guest` | 0051 | after `event_cancelled` |
| `admin_remove_guest` | 0051 | after `event_cancelled` |
| `admin_add_roster_member_to_event` | 0057 | after `event_cancelled` |
| `mark_attendance` | 0017 | after `event_not_found` (no cancelled guard) |

### App-layer changes

- [ ] `event_archived: "This event is archived and its roster is read-only."` added to `ERROR_MESSAGES` in `src/app/(app)/admin/events/actions.ts`
- [ ] `handleMark` in `EventRosterSheet.tsx` checks `rpcError.message === "event_archived"` and shows friendly message instead of generic fallback

### Manual QA (after applying 0061 in staging)

**Archived event — roster write attempts blocked at DB layer:**
- [ ] Admin opens EventRosterSheet on a non-archived past event → all controls visible and functional
- [ ] Manually archive that event (via archive_event RPC or Supabase SQL)
- [ ] Admin opens EventRosterSheet on the now-archived event (readOnly UI) → Add Member/Guest controls hidden, attendance shows static pills
- [ ] Manually call `admin_add_member` on the archived event via Supabase SQL Editor → expect `event_archived` exception
- [ ] Manually call `admin_remove_participant` on an archived event → expect `event_archived` exception
- [ ] Manually call `admin_force_confirm` on an archived event → expect `event_archived` exception
- [ ] Manually call `admin_offer_spot` on an archived event → expect `event_archived` exception
- [ ] Manually call `admin_expire_offer` on an archived event → expect `event_archived` exception
- [ ] Manually call `admin_add_guest` on an archived event → expect `event_archived` exception
- [ ] Manually call `admin_remove_guest` on an archived event → expect `event_archived` exception
- [ ] Manually call `admin_add_roster_member_to_event` on an archived event → expect `event_archived` exception
- [ ] Manually call `mark_attendance` on an archived event → expect `event_archived` exception

**Error message display:**
- [ ] `event_archived` from roster RPCs → displays "This event is archived and its roster is read-only." via `ERROR_MESSAGES` in `actions.ts`
- [ ] `event_archived` from `mark_attendance` → displays "This event is archived and its roster is read-only." inline in the roster row

**Non-archived events unaffected:**
- [ ] All roster mutation RPCs still work normally on active (non-archived) events
- [ ] Cancelled non-archived events: `event_cancelled` guard fires before `event_archived` guard
- [ ] `mark_attendance` still works on confirmed participants in non-archived events

**No regression:**
- [ ] Archive/unarchive buttons still work on eligible events
- [ ] View dropdown (Active / Archived / All) still works
- [ ] Cancel Event still works on eligible future scheduled events
- [ ] Roster read-only UI (from 21O-C) still shows on archived events
- [ ] `pnpm tsc --noEmit` ✓
- [ ] `pnpm build` ✓

**SQL not applied:**
- [ ] Migration 0061 created as file only — NOT applied to staging or production
- [ ] No database schema changes in this phase
- [ ] Apply 0060 first, then 0061, in the correct order

---

## Phase 21P-B — Member Joinable Schema and RPC Guards

**Branch:** `phase-21p-b-member-joinable-schema-rpc`

### Migration 0062 — SQL review checklist (before applying)

> **Apply order: 0060 → 0061 → 0062**

Migration file: `supabase/migrations/0062_member_joinable.sql`

- [ ] File exists at correct path and is numbered 0062
- [ ] Column: `alter table events add column if not exists member_joinable boolean not null default true;` present
- [ ] No partial index added (intentional — deferred to 21P-C when query changes are made)
- [ ] `create_event` updated: `p_member_joinable boolean default true` is the last parameter
- [ ] `create_event` INSERT includes `member_joinable = coalesce(p_member_joinable, true)`
- [ ] Existing `create_event` callers (no `p_member_joinable` arg) still work — column defaults to `true`
- [ ] `join_event` updated: `event_not_joinable` guard present after `event_not_found` check
- [ ] `join_event` guard: `if not v_event.member_joinable then raise exception 'event_not_joinable'; end if;`
- [ ] All other `join_event` behavior preserved (account_inactive, event_already_started, stale offer expiry, waitlist logic, notifications)
- [ ] `leave_event` NOT modified (members can always leave)
- [ ] `accept_waitlist_offer` NOT modified (members can always accept an admin-placed offer)
- [ ] `decline_waitlist_offer` NOT modified
- [ ] Admin roster RPCs (0051/0057) NOT modified
- [ ] `mark_attendance` NOT modified
- [ ] `cancel_event` NOT modified
- [ ] `archive_event` / `unarchive_event` NOT modified

### App-layer changes

- [ ] `AdminEventRow` type in `admin/events/actions.ts`: `member_joinable: boolean` field added
- [ ] `fetchMoreAdminEvents` select string: `member_joinable` included in column list
- [ ] `mapJoinError` in `calendar/EventDetailSheet.tsx`: `event_not_joinable` → "This event is admin-managed. Contact the office to be added to the roster."
- [ ] No UI changes (badge, toggle, query filter) — those are in 21P-C

### Manual QA (after applying 0062 in staging)

**Column and backfill:**
- [ ] `select count(*) from events where member_joinable is null` → 0
- [ ] `select count(*) from events where member_joinable = false` → 0 (no existing events are non-joinable)
- [ ] `select count(*) from events where member_joinable = true` → all existing events

**create_event — joinable (default):**
- [ ] Create event without `p_member_joinable` arg → `member_joinable = true`
- [ ] Create event with `p_member_joinable = true` → `member_joinable = true`
- [ ] All existing event creation flows from UI work unchanged (parameter defaults to true)

**create_event — admin-managed:**
- [ ] Call `create_event(..., p_member_joinable := false)` via SQL Editor → `member_joinable = false` in events table
- [ ] Event still appears in calendar; status = 'scheduled'; court reservation created

**join_event — joinable event:**
- [ ] `join_event` on a `member_joinable = true` event → succeeds (confirmed or waitlisted)
- [ ] All existing join/waitlist flows work unchanged

**join_event — admin-managed event:**
- [ ] `join_event` on a `member_joinable = false` event → raises `event_not_joinable`
- [ ] Error message in EventDetailSheet: "This event is admin-managed. Contact the office to be added to the roster."
- [ ] No event_participants row created

**Other member actions unaffected:**
- [ ] `leave_event` works on a `member_joinable = false` event (if member was admin-added)
- [ ] `accept_waitlist_offer` works on a `member_joinable = false` event
- [ ] `decline_waitlist_offer` works on a `member_joinable = false` event

**Admin roster actions unaffected:**
- [ ] `admin_add_member` works on a `member_joinable = false` event
- [ ] `admin_remove_participant` works on a `member_joinable = false` event
- [ ] `admin_force_confirm` works on a `member_joinable = false` event
- [ ] `admin_offer_spot` works on a `member_joinable = false` event
- [ ] `admin_add_guest` / `admin_remove_guest` work on a `member_joinable = false` event
- [ ] `mark_attendance` works on a `member_joinable = false` event

**Cancel/archive unaffected:**
- [ ] `cancel_event` works on a `member_joinable = false` event
- [ ] `archive_event` works on a `member_joinable = false` event (past/cancelled)
- [ ] `unarchive_event` works on a `member_joinable = false` event

**No UI changes confirmed:**
- [ ] No toggle visible in CreateEventSheet yet (21P-C)
- [ ] No badge visible on Admin Manage cards yet (21P-C)
- [ ] No query filter on member Upcoming yet (21P-C)
- [ ] `pnpm tsc --noEmit` ✓
- [ ] `pnpm build` ✓

**SQL not applied:**
- [ ] Migration 0062 created as file only — NOT applied to staging or production
- [ ] Apply 0060 → 0061 → 0062 in order

---

## Checkpoint 21P-C — Admin-Managed Events UI

**Status: Code complete — pending SQL apply (0062) + manual QA**

### What changed

| File | Change |
| --- | --- |
| `src/app/(app)/calendar/CalendarShell.tsx` | Added `member_joinable` to `RawEventRow`, `EventWithDetails`, `fetchEvents` select, and mapped return object |
| `src/app/(app)/calendar/EventDetailSheet.tsx` | Added `member_joinable` to `EventWithDetails`; "Admin-managed" badge next to event type pill; conditional read-only note replaces Join/Waitlist button when `!member_joinable && !myPart && !isHost` |
| `src/app/(app)/calendar/CreateEventSheet.tsx` | Added `memberJoinable` state (default `true`); toggle in Step 4 with helper text; `p_member_joinable` passed to `create_event` RPC |
| `src/app/(app)/events/page.tsx` | Added `.eq("member_joinable", true)` to member Upcoming query; added `member_joinable` to admin Manage select |
| `src/app/(app)/admin/events/AdminEventsClient.tsx` | "Admin-managed" badge after "Archived" badge on event cards |

No migrations. No RPC changes. No schema changes.

### Manual QA checklist

**Prerequisite: 0062 must be applied before any of these checks.**

**CreateEventSheet — member joinable toggle:**
- [ ] Open Create Event sheet as admin/pro → go to Step 4 → toggle "Members can join this event" visible, defaulted ON
- [ ] Toggle ON: helper text "Members can sign up from the calendar." visible
- [ ] Toggle OFF: helper text "Admin-managed — only staff can add members to the roster." visible; knob slides left
- [ ] Create event with toggle ON → `member_joinable = true` in DB
- [ ] Create event with toggle OFF → `member_joinable = false` in DB

**AdminEventsClient — Admin-managed badge:**
- [ ] Admin Manage tab: event with `member_joinable = false` shows "Admin-managed" badge on card
- [ ] Admin Manage tab: event with `member_joinable = true` shows NO "Admin-managed" badge
- [ ] Archived + admin-managed: both "Archived" and "Admin-managed" badges visible together

**EventDetailSheet — badge:**
- [ ] Calendar: click admin-managed event → "Admin-managed" badge visible next to event type pill
- [ ] Calendar: click normal event → no "Admin-managed" badge

**EventDetailSheet — conditional Join/Waitlist button:**
- [ ] Member (not on roster) views admin-managed event → no Join/Waitlist button; read-only note displayed: "Admin-managed event. Contact the office to be added to the roster."
- [ ] Member already confirmed on admin-managed event → "Leave Event" button still shows
- [ ] Member waitlisted on admin-managed event → "Leave Waitlist" button still shows
- [ ] Member has active offer on admin-managed event → Accept/Pass buttons still show
- [ ] Admin/pro viewing admin-managed event → normal admin controls; no read-only note (canViewRoster = true path)

**Member /events Upcoming tab filter:**
- [ ] Member Upcoming tab: admin-managed event (`member_joinable = false`) NOT shown in list
- [ ] Member Upcoming tab: normal event (`member_joinable = true`) still shown
- [ ] Admin Upcoming tab: admin-managed events also filtered out (both share same `eventsResult` query — by design; admins see all events in Manage tab)
- [ ] Admin Manage tab: admin-managed events visible (uses `adminEventsResult`, no `member_joinable` filter)

**Calendar behavior unaffected:**
- [ ] Admin-managed event still appears on calendar grid (CalendarShell query not filtered by `member_joinable`)
- [ ] Court blocking still works for admin-managed events

**Regression checks:**
- [ ] Archived event roster: still read-only when archived (`readOnly={isArchived}` path in EventRosterSheet unaffected)
- [ ] Cancel event: still works on admin-managed events
- [ ] Archive/unarchive: still works on admin-managed events
- [ ] `pnpm tsc --noEmit` ✓
- [ ] `pnpm build` ✓

---

## Checkpoint 21Q-B — Bookings Cleanup

**Status: Code complete — pending manual QA**

### What changed

| File | Change |
| --- | --- |
| `src/components/BottomNav.tsx` | Renamed tab label "My Schedule" → "Bookings"; removed `smallLabel: true` |
| `src/components/SideNav.tsx` | Renamed tab label "My Schedule" → "Bookings"; href and icon unchanged |
| `src/app/(app)/my-schedule/page.tsx` | Renamed page title "My Schedule" → "My Bookings"; added `offered` to participant status filter; added `offer_expires_at` and `archived_at` to participant/events select; added `archived_at == null` guard on validSignups and pastSignups; added Accept/Pass/Rejoin server actions; updated upcoming event card to render offered state; changed pastItems shape to match PastEventsSection props; replaced inline past events section with PastEventsSection component |
| `src/app/(app)/my-schedule/PastEventsSection.tsx` | New client component — collapsible past events list; collapsed by default; toggle shows "Past events (N)" count; renders attendance badges (Attended / No-show / Past) |

Route unchanged: `/my-schedule`. No migrations. No RPC changes. No schema changes.

### Offered status decision

Included in this phase. Pattern is identical to `EventsUpcomingClient.tsx`. Additions: `offer_expires_at` in select, `"offered"` in status filter, Accept/Pass/Rejoin server actions, offered badge + deadline in upcoming event card. No new RPCs required.

### Manual QA checklist

**Bottom nav (mobile):**
- [ ] Bottom nav label reads "Bookings" (not "My Schedule")
- [ ] "Bookings" label renders at same font size as Calendar / Events / Account (no compression)
- [ ] Tapping Bookings tab navigates to `/my-schedule`
- [ ] Tab highlights correctly (active accent color + border) when at `/my-schedule`

**Side nav (desktop):**
- [ ] Side nav label reads "Bookings" (not "My Schedule")
- [ ] Clicking Bookings navigates to `/my-schedule`
- [ ] Side nav item highlights correctly when at `/my-schedule`
- [ ] Neither nav surface shows "My Schedule" anywhere

**Page title:**
- [ ] Header reads "My Bookings"
- [ ] Route is still `/my-schedule` (not `/my-bookings`)
- [ ] Direct navigation to `/my-schedule` works

**Upcoming court reservations:**
- [ ] Personal court reservations (non-event) appear in upcoming section
- [ ] Court name, time, duration shown correctly
- [ ] Cancel button shows when outside cancellation window or within grace period
- [ ] "Cannot cancel within Nh" message shown when inside window
- [ ] Cancel reservation action works and refreshes page

**Upcoming event signups — confirmed/waitlisted:**
- [ ] Confirmed event signups appear with event type pill and title
- [ ] Waitlisted signups appear with "Waitlisted" badge
- [ ] Leave button works for confirmed signups
- [ ] Leave Waitlist button works for waitlisted signups

**Upcoming event signups — offered:**
- [ ] Active offered signup: "Spot offered" badge shown; Accept + Pass buttons shown
- [ ] Accept deadline shown: "Accept by [time]" when `offer_expires_at` is set
- [ ] Accept button submits and confirms the spot
- [ ] Pass button submits and declines the offer
- [ ] Expired offered signup: "Offer expired" badge shown; Rejoin button shown
- [ ] Rejoin button calls join_event and confirms or waitlists

**Past events section:**
- [ ] Past events section collapsed by default on page load (nothing shown below upcoming)
- [ ] "Past events (N)" toggle row visible when there are past events
- [ ] No toggle shown when user has zero past events
- [ ] Tapping toggle expands past events list; tapping again collapses it
- [ ] Past event cards are read-only (no leave/cancel buttons)
- [ ] Past event cards show date, time, court info
- [ ] Attended badge shown when `attendance_status = 'attended'`
- [ ] No-show badge shown when `attendance_status = 'no_show'`
- [ ] "Past" label shown when attendance not recorded
- [ ] "Host" label shown when myRole = 'host'
- [ ] "Waitlisted" badge shown when user was waitlisted at event time

**Archived events excluded:**
- [ ] Archived event where user is on roster does NOT appear in upcoming or past sections

**Admin/pro personal bookings:**
- [ ] Admin's own court reservations appear in My Bookings
- [ ] Admin's confirmed event signups appear
- [ ] Events admin created but did not join do NOT appear
- [ ] Admin can cancel their own reservations

**Regression:**
- [ ] `/events` Upcoming tab unchanged
- [ ] `/events` Manage tab unchanged
- [ ] `/calendar` unchanged
- [ ] No SQL/migration files changed
- [ ] `pnpm tsc --noEmit` ✓
- [ ] `pnpm build` ✓

---

## Checkpoint 21Q-C1 — Event Consistency Fixes

**Status: Code complete — pending manual QA**

### What changed

| File | Change |
| --- | --- |
| `src/app/(app)/admin/events/page.tsx` | Added `member_joinable` to the initial events select so the Admin-managed badge renders correctly on first load |

No schema changes. No migrations. No RPC changes. No RLS changes.

### Root cause

`AdminEventRow` declares `member_joinable: boolean`. `AdminEventsClient` checks `!ev.member_joinable` to show the Admin-managed badge. The initial SSR query for `/admin/events` was missing `member_joinable` from the select, so the field arrived as `undefined`. `!undefined === true`, causing the badge to appear on every event on first load. The `/events` Manage tab query and `fetchMoreAdminEvents` (pagination) already included `member_joinable` and were not affected.

### member_joinable consistency across all three sources

| Source | Included? |
| --- | --- |
| `admin/events/page.tsx` — initial SSR query | ✓ Fixed |
| `events/page.tsx` — adminEventsResult | ✓ Already correct |
| `fetchMoreAdminEvents` (pagination + view switch) | ✓ Already correct |

### Archived roster read-only path (verified, no change needed)

`AdminEventsClient` passes `readOnly={isArchived}` to `EventRosterButton`, which forwards it to `EventRosterSheet`. In `EventRosterSheet`, `readOnly` gates:
- Add Member / Add Guest controls (`{isAdmin && !readOnly && ...}`)
- Per-row Remove buttons (`{isAdmin && !readOnly && row.role !== "host" && ...}`)
- Attendance toggles (interactive buttons replaced with status label when `readOnly`)
- An "Archived event — roster is read-only" notice banner shown when `readOnly`

No UI correction was needed.

### Manual QA checklist

**Admin-managed badge — /admin/events (initial load):**
- [ ] Create or identify an event where `member_joinable = false`
- [ ] Navigate to `/admin/events` (full page load, no prior navigation)
- [ ] Confirm the event shows the "Admin-managed" badge
- [ ] Confirm all other events do NOT show the "Admin-managed" badge on initial load
- [ ] Switch View filter to "All" or "Archived" — confirm badge still correct on page reload
- [ ] Click "Load more" — confirm new events also show badge only where appropriate

**Admin-managed badge — /events Manage tab:**
- [ ] Navigate to `/events` as admin/pro → Manage tab
- [ ] Confirm same badge behavior as /admin/events (was already correct)
- [ ] Confirm initial load and Load More results are consistent with each other

**Archived roster — read-only:**
- [ ] Switch View to "Archived" on `/admin/events`
- [ ] Open roster for an archived event (button label reads "View Roster (N)")
- [ ] Confirm "Archived event — roster is read-only." banner shown
- [ ] Confirm no Add Member, Add Guest, Remove, or attendance toggle buttons visible
- [ ] Confirm attendance status (Attended / No-show) is displayed as a label, not a button

**Active roster — editable:**
- [ ] Open roster for a non-archived scheduled event
- [ ] Confirm Add Member and Add Guest buttons present
- [ ] Confirm Remove buttons visible per row
- [ ] Confirm attendance toggle buttons (Attended / No-show) are interactive

**Regression:**
- [ ] `/calendar` — calendar day view unchanged
- [ ] `/events` Upcoming tab — member joinable filter unchanged (non-joinable events hidden from members)
- [ ] `/my-schedule` — My Bookings unchanged
- [ ] No SQL/migration files changed
- [ ] `pnpm tsc --noEmit` ✓
- [ ] `pnpm build` ✓

---

## Checkpoint — Admin Events Consolidation

**Status: Code complete — pending manual QA**

### What changed

| File | Change |
| --- | --- |
| `src/app/(app)/events/EventsAdminShell.tsx` | Added `initialTab?: "upcoming" \| "manage"` prop; `useState` now initialized from it |
| `src/app/(app)/events/page.tsx` | Reads `searchParams.tab`; passes `initialTab` to `EventsAdminShell` |
| `src/app/(app)/admin/events/page.tsx` | Replaced with a single `redirect("/events?tab=manage")` |
| `src/app/(app)/admin/events/actions.ts` | Removed two `revalidatePath("/admin/events")` calls (now a redirect, nothing to revalidate) |

No schema changes. No migrations. No RPC changes. No RLS changes. `AdminEventsClient`, `EventRosterButton`, and all actions are unchanged.

### How tab routing works

`/events?tab=manage` passes through `searchParams` in the server component; the value `"manage"` is forwarded as `initialTab` to `EventsAdminShell`, which uses it as the `useState` initial value. Any other value (or no param) defaults to `"upcoming"`. Tab state is purely client-side after first render.

### Manual QA checklist

**Redirect from /admin/events:**
- [ ] Navigate to `/admin/events` — confirm immediate redirect to `/events?tab=manage`
- [ ] Confirm Manage tab is active on arrival (not Upcoming)
- [ ] Confirm all event management features work normally after redirect

**Deep link to Manage tab:**
- [ ] Navigate to `/events?tab=manage` directly — Manage tab opens
- [ ] Navigate to `/events` (no param) — Upcoming tab opens
- [ ] Navigate to `/events?tab=upcoming` — Upcoming tab opens
- [ ] Navigate to `/events?tab=anything` — Upcoming tab opens (unknown values default to upcoming)

**Member behavior unchanged:**
- [ ] Sign in as a member; navigate to `/events` — no Manage tab visible, upcoming events shown
- [ ] Member navigating to `/events?tab=manage` sees upcoming events only (no manage tab rendered)
- [ ] Member navigating to `/admin/events` is redirected to `/events?tab=manage` and sees upcoming only

**Event management features (on /events Manage tab):**
- [ ] Active / Archived / All view switching works
- [ ] Status, date, type, search filters work
- [ ] Load More works and badge consistency is correct
- [ ] Admin-managed badge shows only on non-joinable events
- [ ] + Create Event button opens the create sheet
- [ ] Roster button opens EventRosterSheet
- [ ] Archived event roster is read-only
- [ ] Cancel, Archive, Unarchive actions work

**Regression:**
- [ ] `/calendar` unchanged
- [ ] `/my-schedule` (Bookings) unchanged
- [ ] `pnpm tsc --noEmit` ✓
- [ ] `pnpm build` ✓

---

## Checkpoint — Lifecycle Clarity (My Bookings Past Events)

**Status: Code complete — pending manual QA**

### What changed

| File | Change |
| --- | --- |
| `src/app/(app)/my-schedule/page.tsx` | `pastSignups` filter now includes cancelled non-archived events (was restricted to `status = 'scheduled'`); added `eventStatus` field to `pastItems` mapping |
| `src/app/(app)/my-schedule/PastEventsSection.tsx` | Added `eventStatus` to `PastEventItem` type; added Cancelled badge; added "Offer expired" right-side label for `myStatus === 'offered'` |

No query changes. No schema changes. No RPC changes.

### Status display rules

**Badge strip (left side of each card):**

| Condition | Badge shown |
| --- | --- |
| `eventStatus === "cancelled"` | Red "Cancelled" pill |
| `myStatus === "waitlisted"` | Amber "Waitlisted" pill |
| Both | Both pills |
| Neither | Event type pill only |

**Right-side label (priority order):**

| Condition | Label |
| --- | --- |
| `myRole === "host"` | Host |
| `myAttendance === "attended"` | Attended (green) |
| `myAttendance === "no_show"` | No-show (red) |
| `myStatus === "offered"` | Offer expired (gray) |
| Otherwise | Past (gray) |

### Manual QA checklist

**Cancelled events in Past Events:**
- [ ] An event the user was confirmed on that was later cancelled appears in Past Events
- [ ] That card shows a red "Cancelled" badge alongside the event type pill
- [ ] Right-side label is "Attended", "No-show", or "Past" depending on attendance

**Offer expired in Past Events:**
- [ ] A user whose offered status expired on a past event sees "Offer expired" (not "Past")
- [ ] "Offer expired" uses the same gray color as the "Past" label

**Existing labels unchanged:**
- [ ] Attended (green) still shown when `attendance_status = 'attended'`
- [ ] No-show (red) still shown when `attendance_status = 'no_show'`
- [ ] Host (gray) still shown when `myRole = 'host'`
- [ ] Waitlisted (amber badge) still shown when `myStatus = 'waitlisted'`
- [ ] Ordinary past events show "Past" when no attendance recorded

**Archived events:**
- [ ] Archived events do NOT appear in Past Events (filter unchanged)
- [ ] A cancelled-then-archived event does NOT appear

**Upcoming section unchanged:**
- [ ] Upcoming court reservations unaffected
- [ ] Upcoming event signups (confirmed / waitlisted / offered) unaffected
- [ ] Accept / Pass / Rejoin actions on offered upcoming signups unaffected

---

## Checkpoint — Lifecycle Hardening (Member RPC Archived Guards)

**Status: Migration written — pending application in Supabase SQL Editor**

### What changed

| File | Change |
| --- | --- |
| `supabase/migrations/0063_member_rpc_lifecycle_guards.sql` | Adds `event_archived` guard to `join_event`, `leave_event`, `accept_waitlist_offer`, `decline_waitlist_offer`, `cancel_event` |
| `src/app/(app)/calendar/EventDetailSheet.tsx` | Adds `event_archived` to `mapJoinError`, `mapLeaveError`, `mapOfferError`, `handleCancelEvent` error maps |

### Audit findings — complete protection matrix

| RPC | auth | account_inactive | cross-club | cancelled | archived | started |
| --- | --- | --- | --- | --- | --- | --- |
| `join_event` | ✓ | ✓ | ✓ | ✓ implicit (`status='scheduled'`) | ✓ 0063 | ✓ `event_already_started` |
| `leave_event` | ✓ | — | ✓ | ✓ acceptable (leave works; queue advance skipped) | ✓ 0063 | — |
| `accept_waitlist_offer` | ✓ | — | ✓ | ✓ implicit (`status='scheduled'`) | ✓ 0063 | — |
| `decline_waitlist_offer` | ✓ | — | ✓ | ✓ (advance only if `status='scheduled'`) | ✓ 0063 | — |
| `cancel_event` | ✓ | — | ✓ | ✓ implicit (`status='scheduled'`) | ✓ 0063 | — |

Admin RPCs (`admin_add_member`, `admin_remove_participant`, etc.) received `event_archived` guards in migration 0061.

### Guard pattern

```sql
if v_event.archived_at is not null then raise exception 'event_archived'; end if;
```

For `leave_event`: added an upfront event query (`and club_id = v_profile.club_id`, no status filter) so the guard fires before the participant row is modified. For `decline_waitlist_offer`: the event fetch was moved before the participant UPDATE so the archived guard fires before any state change; no participant row is cancelled if the event is archived.

### How to apply

1. Open Supabase SQL Editor → project SQL Editor
2. Paste the contents of `supabase/migrations/0063_member_rpc_lifecycle_guards.sql`
3. Run. Verify 5 functions replaced with no errors.

### SQL regression tests (run in SQL Editor after applying)

```sql
-- Setup: assumes an archived event and an active member exist.
-- Replace UUIDs with real values from your database.

-- 1. join_event on archived event → should raise 'event_archived'
select join_event('<archived-event-uuid>');

-- 2. join_event on active event → should succeed (confirmed or waitlisted)
select join_event('<active-future-event-uuid>');

-- 3. leave_event on archived event → should raise 'event_archived'
select leave_event('<archived-event-uuid>');

-- 4. accept_waitlist_offer on archived event → should raise 'event_archived'
select accept_waitlist_offer('<archived-event-uuid>');

-- 5. decline_waitlist_offer on archived event → should raise 'event_archived'
select decline_waitlist_offer('<archived-event-uuid>');

-- 6. cancel_event on archived event (as admin) → should raise 'event_archived'
select cancel_event('<archived-event-uuid>');

-- 7. cancel_event on active scheduled event (as admin) → should succeed
select cancel_event('<active-scheduled-event-uuid>');
```

### Manual QA checklist

**Existing member flows unchanged (regression):**
- [ ] Member can join an upcoming event (confirmed or waitlisted)
- [ ] Member can leave an upcoming event
- [ ] Member can accept a waitlist offer on an active event
- [ ] Member can decline a waitlist offer on an active event
- [ ] Admin/host can cancel an active scheduled event

**No archived-event surface in member UI:**
- [ ] `/events` upcoming tab shows no archived events
- [ ] `/my-schedule` upcoming section shows no archived events
- [ ] Past Events section shows no archived events
- [ ] `pnpm tsc --noEmit` ✓
- [ ] `pnpm build` ✓

---

## Pilot Readiness — Production Smoke-Test Checklist

**Purpose:** Full end-to-end pilot flow. Run this on production (or a staging
environment that mirrors production) before handing the app to the first client.
Each item must pass with ✓ before pilot launch.

### Environment pre-checks

- [ ] `verify_production_setup.sql` returns 0 MISSING rows in all checks
- [ ] All 20 required RPCs return EXISTS in check 7
- [ ] Columns `archived_at` and `member_joinable` exist on `events` (check 3)
- [ ] `club-logos` storage bucket exists and is public (check 9)
- [ ] `notifications` table is in `supabase_realtime` publication (check 6)
- [ ] Vercel build deployed with no TypeScript errors
- [ ] `.env` has `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`

---

### A. Authentication

- [ ] Admin can sign in at `/sign-in` with correct credentials
- [ ] Member can sign in at `/sign-in` with correct credentials
- [ ] Unauthenticated `/calendar` redirects to `/sign-in`
- [ ] Unauthenticated `/admin/members` redirects to `/sign-in`
- [ ] Member cannot access `/admin/members` (redirected to `/calendar`)
- [ ] Password reset email (`/forgot-password`) arrives and allows reset

---

### B. Admin: Club setup verification

- [ ] Admin → Account → **Overview** link is visible
- [ ] Overview page loads with today's reservations, events, offers, system status
- [ ] SMS status shows "Configured" or "Not configured" (never crashes)
- [ ] Email status shows "Configured" or "Not configured" (never crashes)
- [ ] Delivery failures (48 h) section shows count (0 is green)
- [ ] Admin → Settings: booking window, cancellation window, offer window are correct
- [ ] Admin → Courts: all courts listed with correct names
- [ ] Admin → Members: pilot members listed with correct roles

---

### C. Court booking

- [ ] Member can view available slots in calendar view
- [ ] Member can book an available court slot → reservation appears in My Schedule
- [ ] Booking outside booking window is blocked with a clear error
- [ ] Member can cancel a reservation from My Schedule
- [ ] Cancelled reservation slot becomes available again in calendar
- [ ] Admin can view court reservations in Overview → Today's court reservations

---

### D. Events

- [ ] Admin can create an event (via Events → Manage → create flow)
- [ ] Event appears in the upcoming Events tab for members
- [ ] Member can join an event → status = confirmed
- [ ] Member can join a full event → status = waitlisted
- [ ] Member can leave a confirmed event
- [ ] Member can leave the waitlist

---

### E. Waitlist offer flow

- [ ] A confirmed member leaving a full event triggers a waitlist offer
- [ ] The waitlisted member receives an in-app notification (bell count increments)
- [ ] Member can accept the offer → status = confirmed
- [ ] Member can decline the offer → next waitlisted member is offered
- [ ] Expired offer (after offer window) is skipped; next member is offered
- [ ] My Schedule shows "Offered" state with Accept / Decline actions

---

### F. Roster management (admin)

- [ ] Admin can view roster in Events → Manage → Roster sheet
- [ ] Admin can add a member to an event directly
- [ ] Admin can remove a participant
- [ ] Admin can promote a waitlisted member
- [ ] Admin can add a guest (name + optional email)
- [ ] Admin can remove a guest
- [ ] Participant count and waitlist count update correctly after each action

---

### G. Event lifecycle (admin)

- [ ] Admin can cancel a scheduled event → all members notified
- [ ] Admin can archive a past or cancelled event
- [ ] Archived event disappears from all member-facing views
- [ ] Archived event appears in admin Events → archive tab
- [ ] join_event on archived event returns clear error in UI ("This event is archived…")
- [ ] Admin can unarchive an event (it returns to normal state)

---

### H. In-app notifications

- [ ] Notification bell shows correct unread count
- [ ] Bell count updates in real time when a new notification arrives (no refresh needed)
- [ ] Clicking bell opens notification list
- [ ] Notification marked read on view; count decrements
- [ ] Event cancellation → affected members each see a notification

---

### I. SMS and email delivery (if configured)

**SMS (Twilio):**
- [ ] Admin → Settings → SMS test sends a message to the admin's phone
- [ ] Waitlist offer notification delivers via SMS (check `notification_deliveries`)
- [ ] `notification_deliveries` rows show `status = 'sent'` (not `failed`)

**Email (Resend):**
- [ ] Waitlist offer email arrives with correct event title and accept/decline link
- [ ] Event cancellation email arrives for affected members
- [ ] Delivery rows show `status = 'sent'`

---

### J. Mobile experience

- [ ] App loads correctly on iOS Safari (no horizontal scroll)
- [ ] Bottom nav tabs are tappable and navigate correctly
- [ ] Calendar scrolls smoothly; court slots are tappable at finger size
- [ ] Event detail sheet opens and closes correctly
- [ ] Booking sheet opens; slot selection and confirmation work on mobile
- [ ] My Schedule loads and Cancel / Leave actions work on mobile

---

### K. Final sign-off

- [ ] All checks above pass
- [ ] `pnpm tsc --noEmit` — 0 errors
- [ ] `pnpm build` — clean build, no errors
- [ ] `verify_production_setup.sql` re-run — 0 MISSING in all checks
- [ ] At least one full member journey (sign-in → book court → join event → receive notification) completed end-to-end

---

## Phase 21L Recovery — Pilot Sales Readiness: Public Marketing Pages

**Recovery note:** Phase 21L work was originally developed on a separate branch and
cherry-picked onto `phase-21l-recovered` after Phase 22B. The committed content is
in `supabase/scripts/QA_phase21L_recovered.md` (the full QA record) and the
`src/app/(marketing)/` route group. This section records the recovery audit findings.

**Recovery status: Audited — uncommitted corrections below**

### What was recovered (commit 810d7f2)

Public-facing marketing/sales layer added as the `(marketing)` route group. No
changes to authenticated `(app)` routes.

| Route | File | Auth |
|---|---|---|
| `/` | `(marketing)/page.tsx` | Redirects logged-in users to `/calendar` |
| `/pricing` | `(marketing)/pricing/page.tsx` | Public |
| `/contact` | `(marketing)/contact/page.tsx` | Public |
| `/terms` | `(marketing)/terms/page.tsx` | Public |
| `/privacy` | `(marketing)/privacy/page.tsx` | Public |

`src/app/page.tsx` deleted; its authenticated-user redirect logic lives in
`(marketing)/page.tsx`. App routes are unaffected.

### Audit findings

**Product claim accuracy:** All claims verified accurate for current app state. No
false claims about automated email delivery, self-service signup, payment processing,
or free trials. Pricing FAQ explicitly states "Not during the founding period" for
billing start. All CTAs route to `/contact` (no self-serve flow).

**Compatibility with Phase 22B onboarding:** Marketing pages are public-only and
have no interaction with the invite/join/auth flows. The `(marketing)` layout does
not use any app chrome (SideNav, BottomNav). The root `/` route redirect behavior
(`if (user) redirect('/calendar')`) is preserved. No conflicts found.

**Navigation integrity:** All internal links verified: `/contact`, `/pricing`,
`/sign-in`, `/terms`, `/privacy`. No broken routes. Sign in → `/sign-in` hits
middleware correctly for authenticated redirect.

**Dark mode:** All marketing pages use Tailwind `dark:` variants consistent with
the app's existing dark mode pattern.

**Corrections made during audit:**
- `QA_phase21L_recovered.md` line 5040: stale `$99/month and $999/year` pricing
  checkbox corrected to `$149/month or $1,490/year` to match current pricing page.

### Files in this recovery

| File | Status |
|---|---|
| `src/app/(marketing)/layout.tsx` | New — marketing shell |
| `src/app/(marketing)/page.tsx` | New — landing page (`/`) |
| `src/app/(marketing)/pricing/page.tsx` | New |
| `src/app/(marketing)/contact/page.tsx` | New |
| `src/app/(marketing)/terms/page.tsx` | New |
| `src/app/(marketing)/privacy/page.tsx` | New |
| `src/app/(marketing)/template.tsx` | New — page entrance animation |
| `src/app/(marketing)/components/MarketingNav.tsx` | New |
| `src/app/(marketing)/components/MarketingFooter.tsx` | New |
| `src/app/(marketing)/components/MarketingReveal.tsx` | New — scroll-reveal |
| `src/app/globals.css` | Appended — `mkt-page-enter` + `mkt-reveal` CSS |
| `src/app/layout.tsx` | Updated metadata description |
| `src/app/page.tsx` | Deleted (replaced by marketing page.tsx) |
| `supabase/scripts/QA_phase21L_recovered.md` | Added — full Phase 21L QA record |

No database changes. No migrations. No Stripe. No payment logic.

### QA checklist (Phase 21L recovery)

**Routing:**
- [ ] Logged-out user visits `/` → sees landing page (not sign-in redirect)
- [ ] Logged-in user visits `/` → redirected to `/calendar`
- [ ] `/pricing`, `/contact`, `/terms`, `/privacy` load without auth

**Marketing layout:**
- [ ] Nav: Court Time wordmark, Pricing, Contact, Sign in links present
- [ ] Footer: Terms, Privacy, Contact, Sign in links present
- [ ] No SideNav or BottomNav on any marketing page
- [ ] Dark mode renders correctly on all marketing pages

**Landing page claims:**
- [ ] Hero: "Less chaos. More tennis."
- [ ] "Request early access" → `/contact`
- [ ] "Sign in →" → `/sign-in`
- [ ] Feature cards describe implemented features (court booking, events, roster, mobile)
- [ ] No unimplemented features claimed

**Pricing:**
- [ ] Founding Club: $149/month or $1,490/year
- [ ] "No credit card required · Setup is free during the founding period"
- [ ] Billing FAQ: "Not during the founding period"
- [ ] Standard plans labeled "after founding period"

**Authenticated app regression:**
- [ ] `/calendar`, `/admin/members`, `/events`, `/my-schedule` unaffected
- [ ] App layout (SideNav + BottomNav) does not appear on marketing pages
- [ ] `pnpm tsc --noEmit` ✓ / `pnpm build` ✓
