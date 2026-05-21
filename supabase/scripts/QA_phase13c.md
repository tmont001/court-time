# Phase 13C — Multi-Club Onboarding End-to-End QA Checklist

Run this checklist after Phase 13A (migration 0035) and Phase 13B (bootstrap
script) are deployed. All SQL runs in the **Supabase SQL Editor**. All browser
steps use an **incognito or private window** so pilot-club sessions do not
interfere.

Mark each item **PASS** or **FAIL**. A single FAIL should stop the run.

---

## Part 1 — Bootstrap the test club

### 1.1 — Find your operator UUID

Run in SQL Editor:

```sql
select id, email
from auth.users
order by created_at;
```

Copy your UUID. You will paste it into the bootstrap script.

**Record:** `operator_user_id = ________________________________`

---

### 1.2 — Run the bootstrap script

Open `supabase/scripts/bootstrap_new_club.sql`.

Edit the **EDIT THESE VALUES** section:

```
p_name        = 'QA Test Club'
p_slug        = 'qa-test'
p_timezone    = 'America/New_York'
p_court_count = 3
p_operator_user_id = '<UUID from 1.1>'
p_court_names = null          (default: Court 1, Court 2, Court 3)
p_opens_at    = '08:00'
p_closes_at   = '20:00'
p_booking_window_days        = 14
p_cancellation_window_hours  = 24
p_cancellation_grace_minutes = 5
app_url       = 'https://court-time.vercel.app'
```

Paste the full edited script into SQL Editor and run it.

**Expected:** One result row with four columns.

**Record:**
```
club_id     = ________________________________
slug        = qa-test
invite_code = ________________________________
invite_url  = https://court-time.vercel.app/join/________________________________
```

- [ ] **1.2 PASS** — Result row returned with all four values populated.

---

## Part 2 — SQL row verification (before any user logs in)

Replace `'qa-test'` with your slug in each query if you used a different one.

### 2.1 — Clubs row

```sql
select id, name, slug, timezone, theme_key, logo_url, created_at
from clubs
where slug = 'qa-test';
```

- [ ] **2.1 PASS** — 1 row. `name = 'QA Test Club'`, `theme_key = 'classic-gray'`, `logo_url` is null.

---

### 2.2 — Club settings row

```sql
select
  booking_window_days,
  cancellation_window_hours,
  cancellation_grace_minutes
from club_settings
where club_id = (select id from clubs where slug = 'qa-test');
```

- [ ] **2.2 PASS** — 1 row. Values match what was passed to the script (14 / 24 / 5).

---

### 2.3 — Courts (expect 3)

```sql
select name, display_order, is_active
from courts
where club_id = (select id from clubs where slug = 'qa-test')
order by display_order;
```

- [ ] **2.3 PASS** — 3 rows: `Court 1 (0)`, `Court 2 (1)`, `Court 3 (2)`. All `is_active = true`.

---

### 2.4 — Operating hours (expect 7)

```sql
select day_of_week, opens_at, closes_at, is_closed
from operating_hours
where club_id = (select id from clubs where slug = 'qa-test')
order by day_of_week;
```

- [ ] **2.4 PASS** — Exactly 7 rows, `day_of_week` 0–6, all `opens_at = 08:00`, `closes_at = 20:00`, `is_closed = false`.

---

### 2.5 — Event types (expect 5)

```sql
select key, label, color, default_capacity, default_duration_minutes,
       default_court_count, shows_participant_names
from event_types
where club_id = (select id from clubs where slug = 'qa-test')
order by key;
```

- [ ] **2.5 PASS** — Exactly 5 rows with keys: `clinic`, `league`, `lesson`, `social`, `tournament`. Values match the Phase 13A spec.

---

### 2.6 — First admin invite (not yet accepted)

```sql
select code, role, email, expires_at, accepted_at, accepted_by, revoked_at
from club_invites
where club_id = (select id from clubs where slug = 'qa-test');
```

- [ ] **2.6 PASS** — 1 row. `role = 'admin'`, `email` is null, `accepted_at` is null, `revoked_at` is null, `expires_at` is ~14 days from now.

---

### 2.7 — Validate invite code

```sql
select validate_club_invite('<invite_code from 1.2>');
```

- [ ] **2.7 PASS** — Returns `{"valid": true, "role": "admin", "email": null, "club_name": "QA Test Club"}`.

---

### 2.8 — Pilot club unchanged

```sql
select cl.name, cl.slug, count(c.id) as court_count
from clubs cl
join courts c on c.club_id = cl.id
where cl.slug = 'riverside'
group by cl.name, cl.slug;
```

- [ ] **2.8 PASS** — `Riverside Tennis Club | riverside | 5`.

```sql
select count(*) as event_type_count
from event_types
where club_id = (select id from clubs where slug = 'riverside');
```

- [ ] **2.9 PASS** — `event_type_count = 5`.

```sql
select count(*) as total_clubs from clubs;
```

- [ ] **2.10 PASS** — `total_clubs = 2` (riverside + qa-test). No extra rows.

---

## Part 3 — Create the first admin Auth account

In the Supabase **Authentication** dashboard → **Users** → **Add user**:

- Email: use a real address you control, or a `+qa` alias (e.g., `you+qa@example.com`)
- Password: `TempPass123!` (or any strong temporary password)
- Check **Auto Confirm User**

**Record:** `first_admin_email = ________________________________`

- [ ] **3.1 PASS** — New user appears in the Auth users list with status Confirmed.

---

## Part 4 — Browser walkthrough

Use an **incognito window** for all steps in this section. Do not reuse any
existing signed-in session.

---

### 4.1 — Sign in as the new admin

Navigate to: `https://court-time.vercel.app/sign-in`

Sign in with the email and password from Part 3.

- [ ] **4.1 PASS** — Sign-in succeeds without error.

---

### 4.2 — Confirm redirect to /pending-invite

After sign-in, confirm the browser lands on:
`https://court-time.vercel.app/pending-invite`

Expected page text: *"Almost there"* and *"Use the invite link your club admin
sent you to get started."*

- [ ] **4.2 PASS** — Page shows the pending-invite message. No calendar, no nav.

---

### 4.3 — Attempt direct navigation (should stay on /pending-invite)

While still signed in as the new admin, navigate directly to:
`https://court-time.vercel.app/calendar`

- [ ] **4.3 PASS** — Immediately redirected back to `/pending-invite`. The app
  does not show calendar content to a user with no club.

---

### 4.4 — Visit the invite URL

Navigate to the `invite_url` recorded in step 1.2:
`https://court-time.vercel.app/join/<invite_code>`

**Expected:** A page showing:
- Club name: **QA Test Club**
- Role: **admin**
- An **Accept invitation** button

- [ ] **4.4 PASS** — Invite page loads with correct club name and role.

---

### 4.5 — Accept the invite

Click **Accept invitation**.

- [ ] **4.5 PASS** — No error message shown.

---

### 4.6 — Redirect to /welcome

After accepting, confirm the browser redirects to:
`https://court-time.vercel.app/welcome`

Fill in a first name and last name, then submit.

- [ ] **4.6 PASS** — Welcome form submits without error.

---

### 4.7 — Land on /calendar

After submitting /welcome, confirm the browser redirects to:
`https://court-time.vercel.app/calendar`

- [ ] **4.7 PASS** — Calendar page loads. Bottom nav is visible.

---

### 4.8 — Confirm only QA Test Club courts appear

On the calendar, check the court columns (or court selector if applicable).

- [ ] **4.8 PASS** — Exactly 3 courts visible: **Court 1**, **Court 2**,
  **Court 3**. No Riverside courts visible (Court 4, Court 5 must not appear).

---

### 4.9 — Confirm admin settings show the new club name

Navigate to: `https://court-time.vercel.app/admin/settings`

- [ ] **4.9 PASS** — Club name field shows **QA Test Club**.
- [ ] **4.10 PASS** — No error, no redirect. Admin layout grants access.

---

### 4.10 — Confirm the new admin can create a member invite

Navigate to: `https://court-time.vercel.app/admin/members`

Create an invite:
- Role: **member**
- Email: leave blank (open invite)
- Click create / generate link

- [ ] **4.11 PASS** — Invite link is generated successfully. No error.
- [ ] **4.12 PASS** — The generated invite URL starts with
  `https://court-time.vercel.app/join/` and contains a new code (different
  from the first-admin invite code).

---

### 4.11 — Confirm the member invite is scoped to QA Test Club

Run in SQL Editor:

```sql
select ci.code, ci.role, ci.club_id, cl.slug
from club_invites ci
join clubs cl on cl.id = ci.club_id
where cl.slug = 'qa-test'
order by ci.created_at desc
limit 3;
```

- [ ] **4.13 PASS** — The newly created member invite appears with `club_id`
  matching the QA test club, not the Riverside club.

---

## Part 5 — Isolation verification (pilot club unaffected)

### 5.1 — Sign in as a Riverside pilot admin

Open a **second incognito window** (or use a different browser). Sign in as
the existing pilot club admin account.

Navigate to: `https://court-time.vercel.app/calendar`

- [ ] **5.1 PASS** — Calendar loads without error.

---

### 5.2 — Confirm pilot admin sees only Riverside courts

On the calendar, check court columns.

- [ ] **5.2 PASS** — Riverside courts appear (5 courts). **No QA Test Club
  courts appear** (Court 1/2/3 from the QA club must not be visible — note
  that Riverside also has Court 1/2/3, so verify by total count: exactly 5
  courts, matching Riverside's court names).

> **Tip:** Navigate to `/admin/courts` on the pilot admin session to see the
> full court list with IDs.

---

### 5.3 — Confirm pilot admin settings show Riverside

Navigate to: `https://court-time.vercel.app/admin/settings`

- [ ] **5.3 PASS** — Club name shows **Riverside Tennis Club**, not QA Test Club.

---

### 5.4 — New admin cannot access pilot club data (RLS check)

While signed in as the **new QA Test Club admin** (from Part 4), navigate to:
`https://court-time.vercel.app/admin/members`

- [ ] **5.4 PASS** — Only QA Test Club members appear (just the new admin
  themselves). No Riverside members visible.

Navigate to: `https://court-time.vercel.app/admin/settings`

- [ ] **5.5 PASS** — Club name shows **QA Test Club**. No Riverside data visible.

---

## Part 6 — Post-acceptance SQL verification

Run these after Part 4 (the new admin has accepted the invite).

### 6.1 — First admin invite is marked accepted

```sql
select
  code,
  role,
  accepted_at,
  accepted_by
from club_invites
where club_id = (select id from clubs where slug = 'qa-test')
order by created_at desc
limit 1;
```

- [ ] **6.1 PASS** — `accepted_at` is not null. `accepted_by` matches the
  new admin's UUID.

Confirm the UUID:

```sql
select id, email
from auth.users
where email = '<first_admin_email from Part 3>';
```

- [ ] **6.2 PASS** — `accepted_by` in the invite row matches this UUID.

---

### 6.2 — New admin profile has correct club_id and role

```sql
select p.id, p.club_id, p.role, p.status, p.first_name, p.last_name
from profiles p
join auth.users u on u.id = p.id
where u.email = '<first_admin_email from Part 3>';
```

- [ ] **6.3 PASS** — `club_id` matches the QA test club UUID (from step 1.2).
  `role = 'admin'`. `status = 'active'`. `first_name` and `last_name` are
  populated (set in /welcome).

---

### 6.3 — Audit log has accept_invite entry

```sql
select actor_id, action, target_type, metadata, created_at
from audit_log
where club_id = (select id from clubs where slug = 'qa-test')
order by created_at desc
limit 5;
```

- [ ] **6.4 PASS** — At least one row with `action = 'accept_invite'` and
  `target_type = 'profile'`. The `metadata` jsonb contains `"role": "admin"`.

---

### 6.4 — Pilot club row counts still correct

```sql
select
  (select count(*) from courts
   where club_id = (select id from clubs where slug = 'riverside'))  as riverside_courts,
  (select count(*) from operating_hours
   where club_id = (select id from clubs where slug = 'riverside'))  as riverside_hours,
  (select count(*) from event_types
   where club_id = (select id from clubs where slug = 'riverside'))  as riverside_event_types;
```

- [ ] **6.5 PASS** — `riverside_courts = 5`, `riverside_hours = 7`,
  `riverside_event_types = 5`. All unchanged.

---

## Part 7 — Final summary

| # | Check | Result |
|---|---|---|
| 1.2 | Bootstrap script returns all 4 values | |
| 2.1–2.10 | All SQL row counts correct before login | |
| 3.1 | Auth user created and confirmed | |
| 4.2 | New admin lands on /pending-invite before accepting | |
| 4.3 | Direct nav to /calendar blocked before accepting | |
| 4.4 | Invite page shows correct club and role | |
| 4.5 | Invite accepted without error | |
| 4.6 | Redirect to /welcome | |
| 4.7 | Redirect to /calendar after /welcome | |
| 4.8 | Calendar shows only 3 QA Test Club courts | |
| 4.9–4.10 | Admin settings shows QA Test Club | |
| 4.11–4.12 | New admin can create member invite | |
| 4.13 | Member invite scoped to QA test club | |
| 5.1–5.3 | Pilot admin sees only Riverside data | |
| 5.4–5.5 | New admin cannot see Riverside data | |
| 6.1–6.2 | Invite marked accepted with correct accepted_by | |
| 6.3 | New admin profile has correct club_id, role, name | |
| 6.4 | Audit log has accept_invite entry | |
| 6.5 | Pilot club row counts unchanged | |

**Phase 13C PASS** = all items above marked PASS.

---

## Optional cleanup after testing

If you want to remove the test club after a successful QA run:

```sql
-- Cascading deletes remove club_settings, courts, operating_hours,
-- event_types, club_invites, reservations, events, and notifications
-- for this club in one statement.
-- WARNING: this also deletes any profile rows whose club_id = this club.
-- Run only if you are certain this is a test club with no real data.

delete from clubs where slug = 'qa-test';
```

Then delete the test Auth user from the Supabase **Authentication** dashboard.

> Do not run the cleanup query against `slug = 'riverside'` or any
> production club.
