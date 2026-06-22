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

**Status: In progress — complete all items before moving to Phase 21E**

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
