# Pilot Onboarding — North Shore Towers

This document is for the operator or admin preparing to onboard the tennis court
coordinator and first wave of pilot members to the North Shore Towers booking app.

- **Production URL:** `https://court-time.vercel.app`
- **Pilot club:** North Shore Towers (`north-shore-towers`)
- **Sandbox (do not use for real members):** Riverside (`riverside`)

---

## Section 1 — Coordinator invite plan

### Recommended role: admin (not member)

Invite the court coordinator as **admin** from the start.

**Rationale:** The coordinator's job requires admin access from day one — they need
to create events, manage court reservations, invite members, view the audit log, and
adjust settings. Inviting as member first and upgrading later creates an unnecessary
extra step and prevents them from setting up real events before members arrive.

A pro role would let them manage events and rosters but not invite members or adjust
settings. Only use pro if the coordinator will never manage invites or club settings.

### How to create the invite

1. Sign in as an existing North Shore Towers admin at
   `https://court-time.vercel.app`.
2. Navigate to `/admin/members` → **Invite**.
3. Set role to **admin**.
4. Enter the coordinator's email address in the email-restriction field. This
   ensures the link can only be accepted by that person.
5. Copy the generated `/join/<code>` URL.

**Before sending, verify the invite belongs to North Shore Towers — not Riverside:**

```sql
select ci.code, c.name as club_name, c.slug, ci.role, ci.email
from club_invites ci
join clubs c on c.id = ci.club_id
where ci.code = '<paste-invite-code-here>';
-- Expected: club_name = 'North Shore Towers'; slug = 'north-shore-towers'
```

If `slug` shows `riverside`, the invite was created while signed into the wrong
club. Revoke it and create a new one after signing into North Shore Towers.

### Production URL only

The invite link and all email confirmation links are built against
`https://court-time.vercel.app`. The coordinator must open the link from that URL —
not from localhost, not from a Vercel preview URL, and not from a forwarded or
cached version of the link.

Include this instruction when you send the invite.

---

## Section 2 — Coordinator setup instructions

Send these steps to the coordinator along with the invite link.

### If this is a new account (first time using Court Time)

1. Open the invite link: `https://court-time.vercel.app/join/<code>`
2. Tap **Create account**.
3. Enter your email address and choose a password.
4. Check your inbox for a confirmation email from `no-reply@court-time.app`.
   - If you do not see it within 2 minutes, check your spam folder.
   - Click the confirmation link in the email. It is single-use — do not click
     it more than once.
5. You will be redirected back to the app and automatically joined to
   North Shore Towers.
6. Complete the **Welcome** screen: enter your first and last name, then tap
   **Continue**.
7. You will land on the **Calendar** page. You are in.

### If you already have a Court Time account

1. Open the invite link: `https://court-time.vercel.app/join/<code>`
2. Tap **Sign in to accept**.
3. Sign in with your existing email and password.
4. Tap **Accept invitation** on the `/join/<code>` page.
5. You will be redirected to the Calendar.

### Verify admin access

After landing on the Calendar, confirm your admin pages are accessible:

- `/admin/members` — member list and invite controls
- `/admin/events` — event list with roster management
- `/admin/courts` — court names and availability
- `/admin/settings` — club settings (booking window, cancellation window, logo)
- `/admin/audit-log` — full activity log

If any of these pages show an error or redirect you to the Calendar, contact the
operator — the role on your invite may need to be reviewed.

---

## Section 3 — Coordinator test script

Work through these steps after accepting the invite. They cover both the member
experience (what your members will see) and the admin experience (what you will
manage day-to-day).

**Member flows**

- [ ] **Calendar loads:** navigate to `/calendar`; date strip, court filter chips,
      and time slots are visible. Select a date a few days out.
- [ ] **Book a court:** tap an empty time slot → select a court → choose a duration
      → confirm. Booking appears on the calendar as your block.
- [ ] **Cancel from Calendar:** tap your own booking block on the calendar →
      confirm cancel. Block disappears.
- [ ] **Cancel from My Schedule:** navigate to `/my-schedule`; find a booking →
      tap → cancel. Confirm it disappears from the list.
- [ ] **Join an event:** navigate to `/events`; find a scheduled event → tap
      **Join event**. Status updates to Joined or Waitlisted.
- [ ] **Notification bell:** after joining an event or after the admin sends an
      announcement, the bell badge should show a count. Tap the bell:
      - Desktop: a dropdown panel appears below the header, right-aligned. Content
        is readable; no overlap with the sidebar.
      - Mobile: a bottom sheet slides up. Swipe or tap outside to dismiss.
      - Tap a notification row — it marks as read and the badge decrements.
- [ ] **Notification preferences:** navigate to `/profile/notifications`; toggle
      one preference off and back on. Confirm the toggle saves without error.

**Admin flows**

- [ ] **View members:** `/admin/members` — your own account appears as admin with
      status active.
- [ ] **Create an event:** `/admin/events` → create a new event (type, date, time,
      duration, courts, capacity). Event appears in the list and on `/events`.
- [ ] **View roster:** on the event card, open the roster sheet. Confirm your own
      join (from the step above) appears as a confirmed participant.
- [ ] **Cancel an event:** cancel the test event just created. Confirm it is
      removed from `/events` and `/admin/events`.
- [ ] **Audit log:** `/admin/audit-log` — confirm recent actions (booking, event
      join, event cancel) appear in the log with correct timestamps.

---

## Section 4 — Member quick-start guide

Share this section with pilot members when you send their invite. It can be
copy-pasted into an email or a message.

---

**Welcome to the North Shore Towers booking app.**

Here is everything you need to get started.

**Booking a court**

1. Open the app at `https://court-time.vercel.app` and sign in.
2. Tap the **Calendar** tab at the bottom of the screen.
3. Select the date you want to play.
4. Tap an empty time slot in the court column you want.
5. Choose a duration, then confirm.

Your booking appears as a block on the calendar and in **My Schedule**.

**Cancelling a booking**

- From **Calendar:** tap your own booking block, then tap **Cancel reservation**.
- From **My Schedule:** tap the booking, then tap **Cancel reservation**.

Cancellations must be made at least 24 hours before the reservation start time.
A 5-minute grace period applies immediately after booking.

**Joining an event**

1. Tap the **Events** tab.
2. Find an event and tap **Join event**.
3. If the event is full, you will be placed on the waitlist automatically.
   You will receive a notification if a spot opens for you.

**Notifications**

The bell icon in the top-right corner shows unread notifications. Tap it to see
them. You can control which notifications you receive from
**Profile → Notification preferences**.

**Confirmation email not arriving?**

Check your spam folder — emails come from `no-reply@court-time.app`. If the
confirmation link has already been clicked once, it will not work a second time.
If that happens, go to `https://court-time.vercel.app/forgot-password` to set
a new password, then sign in and visit the invite link again.

**Questions?**

Reach out directly to [admin contact — fill in before sending].

---

---

## Section 5 — Feedback capture template

Collect feedback from the coordinator and each pilot member after their first 1–2
sessions. A short conversation or message is enough — no formal survey required.
Use this template to structure what you capture.

---

**Pilot feedback — [name] — [date]**

**What worked well?**

> (What felt intuitive? What did they do without any guidance?)

**What was confusing?**

> (Any step that required re-reading, asking for help, or a second attempt?)

**What did not work / seemed broken?**

> (Errors, pages that did not load, actions that had no visible effect, unexpected
> redirects. Note: device type and browser if mentioned.)

**Mobile experience**

> (Any layout issues, tap targets too small, sheets not scrolling, bottom nav
> obscured, notification panel behavior?)

**Desktop experience** (if they used desktop)

> (Sidebar visible? Notification panel opened as a dropdown? Calendar grid readable?)

**Must-fix before broader launch**

> (Issues that would stop a non-technical member from completing a task on their own.)

**Nice-to-have / post-pilot**

> (Polish, copy improvements, feature requests that are not blocking.)

---

Classify every item as one of:

| Label | Meaning |
| --- | --- |
| **Fix now** | Blocks a task; resolve before next invite wave |
| **Defer** | Rough edge; log to backlog; does not block pilot |
| **Training** | User confusion that a short explanation resolves; not a product bug |

---

## Section 6 — Known limitations

Share these with the coordinator before they start. Set expectations so that
rough edges are understood as intentional deferrals, not bugs.

| Limitation | Detail |
| --- | --- |
| **One club per account** | Each account belongs to exactly one club. There is no multi-club view or club-switching UI. A person who wants to join a second club would need a separate account with a different email address. Multi-club membership is deferred to a post-pilot phase. |
| **SMS notifications not enabled** | In-app notifications (the bell) are fully functional. SMS delivery requires Twilio configuration, which is deferred. The SMS opt-in option is visible in Profile → Notification preferences but will not deliver messages during the pilot. |
| **No email copies of in-app notifications** | Members receive Supabase Auth emails (invite confirmation, password reset). In-app notification events (booking confirmed, event joined, waitlist promotion) do not currently send email copies. Email notification delivery is a post-pilot enhancement. |
| **Operating hours are fixed** | Club hours (currently 8 AM – 8 PM every day) cannot be changed from the admin UI. Changes require an operator-level SQL edit. An operating hours editor is deferred to a post-pilot settings phase. |
| **Event type labels and colors are fixed** | The five event types (their names and colors) cannot be edited from the admin UI. Changes require an operator-level SQL edit. An event type editor is deferred. |
| **Guest contact details are name-only** | Admin-added guests appear in the event roster with a display name only. Guest email and phone fields are deferred to a post-pilot phase. |
| **Riverside is sandbox only** | The `riverside` club is the operator development sandbox. It contains test data. No real pilot members should receive a Riverside invite link. If a member accidentally lands in Riverside, they will see test data that is unrelated to North Shore Towers. |
| **No public event embed or external booking link** | Events are only visible and joinable inside the app. There is no public-facing calendar embed for non-members. Deferred. |
