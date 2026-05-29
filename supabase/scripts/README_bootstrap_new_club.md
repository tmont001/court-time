# Bootstrapping a New Club

This document describes how an operator provisions a new club so that a first
admin can log in and start inviting members.

All steps run in the **Supabase SQL Editor** or the **Supabase Authentication
dashboard**. No application code changes are needed.

---

## When to use this process

Use this process every time a new club joins the platform. It creates all
database rows that the application requires before any user from that club can
log in:

- `clubs` row
- `club_settings` row
- `courts` rows (one per court)
- `operating_hours` rows (7 rows, one per day)
- `event_types` rows (5 standard types)
- `club_invites` row (first-admin invite, 14-day expiry)

The pilot club (`riverside`) is unaffected by this process. Each new club
gets a new UUID and is fully isolated by row-level security.

---

## Production environment checklist

Complete these steps **once per environment** (production or staging) before
running the bootstrap script for the first time. They are not repeated per club.

### 1 — Vercel environment variables

Set the following in your Vercel project → Settings → Environment Variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon/public key (not service role) |
| `TWILIO_ACCOUNT_SID` | No | Optional — in-app notifications work without it |
| `TWILIO_AUTH_TOKEN` | No | Optional — see SMS note below |
| `TWILIO_FROM_NUMBER` | No | Optional — e.g. `+1xxxxxxxxxx` |

**SMS note:** In-app notifications (the bell) are pilot-critical and require no
Twilio configuration. SMS is optional for the pilot. If Twilio vars are unset,
the SMS test in Admin → Settings shows "SMS not configured" and SMS delivery is
skipped silently. You can add Twilio later without any code changes.

### 2 — Supabase Auth redirect URLs

In Supabase dashboard → Authentication → URL Configuration:

- **Site URL:** set to your production URL, e.g. `https://your-app.vercel.app`
- **Redirect URLs:** add all of the following:
  - `https://your-app.vercel.app/**`
  - `http://localhost:3000/**` (for local development)

Without this, password reset emails and invite flows redirect to the wrong URL.

### 3 — club-logos storage bucket

The storage bucket is not created by migrations — create it manually:

1. Supabase dashboard → Storage → New bucket
2. **Name:** `club-logos`
3. **Public bucket:** enabled (logos are publicly readable)
4. **File size limit:** 2 MB (2,097,152 bytes)
5. **Allowed MIME types:** `image/jpeg`, `image/png`, `image/webp`

Without this bucket, logo uploads from Admin → Settings will fail.

### 4 — Notifications realtime publication

The in-app notification bell uses Supabase Realtime. Run this **once** in the
SQL Editor to add the `notifications` table to the realtime publication:

```sql
alter publication supabase_realtime add table notifications;
```

Without this, the notification bell count does not update in real time (new
notifications require a page refresh to appear).

### 5 — Verify the production environment

Run `supabase/scripts/verify_production_setup.sql` in the SQL Editor. All
checks should pass before proceeding to bootstrap. See that file for fix
instructions for any failing checks.

### 6 — Update app_url in the bootstrap script

Before running `bootstrap_new_club.sql`, update the `app_url` field to your
production URL:

```sql
'https://your-app.vercel.app'   as app_url
```

This value is used only to build the `invite_url` returned by the script. It
must match the URL where your app is deployed so that the invite link works.

---

## Prerequisites

- Access to the Supabase project (SQL Editor + Authentication dashboard).
- Migration `0035_bootstrap_new_club.sql` has been applied.
- All steps in **Production environment checklist** above are complete.
- You know the new club's name, slug, timezone, and court count.

---

## Step 1 — Find your operator user UUID

The `bootstrap_new_club` function requires a valid `auth.users` UUID as
`p_operator_user_id`. This is the operator's own account, used as the
`created_by` value on the first admin invite.

Run in SQL Editor:

```sql
select id, email, created_at
from auth.users
order by created_at;
```

Copy the UUID for the operator account (your own account).

---

## Step 2 — Edit and run the bootstrap script

Open `supabase/scripts/bootstrap_new_club.sql` and edit the values in the
**EDIT THESE VALUES** section:

| Field                          | Example                                       | Notes                                          |
| ------------------------------ | --------------------------------------------- | ---------------------------------------------- |
| `p_name`                       | `'Lakeview Tennis Club'`                      | 2–80 characters                                |
| `p_slug`                       | `'lakeview'`                                  | Lowercase, digits, hyphens. Unique. Permanent. |
| `p_timezone`                   | `'America/Chicago'`                           | IANA timezone name                             |
| `p_court_count`                | `3`                                           | 1–20                                           |
| `p_operator_user_id`           | `'abc123...'::uuid`                           | From Step 1                                    |
| `p_court_names`                | `null` or `array['Clay 1','Clay 2','Clay 3']` | null = "Court 1", "Court 2", …                 |
| `p_opens_at`                   | `'08:00'::time`                               | Applied to all 7 days                          |
| `p_closes_at`                  | `'20:00'::time`                               | Must be after `p_opens_at`                     |
| `p_booking_window_days`        | `14`                                          | 1–365                                          |
| `p_cancellation_window_hours`  | `24`                                          | 0–168                                          |
| `p_cancellation_grace_minutes` | `5`                                           | 0–60                                           |
| `app_url`                      | `'https://court-time.vercel.app'`             | No trailing slash                              |

Paste the entire edited script into the Supabase SQL Editor and run it.

**Expected result row:**

| Column        | Description             |
| ------------- | ----------------------- |
| `club_id`     | The new club's UUID     |
| `slug`        | The slug you chose      |
| `invite_code` | 32-character hex code   |
| `invite_url`  | Full `/join/<code>` URL |

Save all four values before closing.

---

## Step 3 — Copy the first admin invite link

The `invite_url` from Step 2 is the link the first admin will use to join
their club. It is valid for **14 days**.

If you need to retrieve it later, run:

```sql
select
  code                                          as invite_code,
  'https://court-time.vercel.app/join/' || code   as invite_url,
  expires_at,
  accepted_at,
  revoked_at
from club_invites
where club_id = '<club_id from Step 2>'
order by created_at desc
limit 1;
```

---

## Step 4 — Create the first admin's Auth account

The invite link requires the recipient to already have a Supabase Auth account.

In the Supabase **Authentication** dashboard → **Users** → **Add user**:

- Email: the new admin's email address
- Password: a temporary password (e.g., `TempPass123!`)
- Leave "Auto Confirm User" checked so they can log in immediately

> The invite link does not send an email. You deliver it manually (Step 5).

---

## Step 5 — Send the first admin the invite link and credentials

Send the new admin:

1. The `invite_url` from Step 2 (e.g., `https://court-time.vercel.app/join/abc123...`)
2. Their temporary password from Step 4
3. Instructions to reset their password via `/forgot-password` after first login

Example message:

> Your Court Time admin account is ready. Sign in at
> https://court-time.vercel.app/sign-in with password `TempPass123!`, then
> visit this link to join your club:
>
> https://court-time.vercel.app/join/abc123...
>
> Please reset your password after logging in.

---

## Step 6 — First admin accepts the invite

The first admin:

1. Signs in at `/sign-in` with the temporary password.
2. Navigates to the invite URL.
3. Clicks **Accept invitation** on the `/join/<code>` page.
4. Is redirected to `/welcome` to fill in their name (if not already set).
5. Is redirected to `/calendar` — the app is ready.

They can now invite pros and members from `/admin/members`.

---

## Step 7 — Verify new club rows

Replace `'lakeview'` with the actual slug in each query.

```sql
-- Club row
select id, name, slug, timezone, theme_key, created_at
from clubs
where slug = 'lakeview';

-- Club settings
select booking_window_days, cancellation_window_hours, cancellation_grace_minutes
from club_settings
where club_id = (select id from clubs where slug = 'lakeview');

-- Courts
select name, display_order, is_active
from courts
where club_id = (select id from clubs where slug = 'lakeview')
order by display_order;

-- Operating hours (expect 7 rows)
select day_of_week, opens_at, closes_at, is_closed
from operating_hours
where club_id = (select id from clubs where slug = 'lakeview')
order by day_of_week;

-- Event types (expect 5 rows)
select key, label, color, default_capacity, default_duration_minutes
from event_types
where club_id = (select id from clubs where slug = 'lakeview')
order by key;

-- First admin invite
select code, role, email, expires_at, accepted_at, revoked_at
from club_invites
where club_id = (select id from clubs where slug = 'lakeview')
order by created_at desc;

-- Validate invite (replace with actual code)
select validate_club_invite('PASTE-INVITE-CODE-HERE');
-- Expected: {"valid": true, "role": "admin", "email": null, "club_name": "..."}
```

---

## Step 8 — Verify pilot club is unchanged

```sql
-- Pilot club court count must still be 5
select cl.name, cl.slug, count(c.id) as court_count
from clubs cl
join courts c on c.club_id = cl.id
where cl.slug = 'riverside'
group by cl.name, cl.slug;
-- Expected: Riverside Tennis Club | riverside | 5

-- Pilot club should have only its own event types
select count(*) as event_type_count
from event_types
where club_id = (select id from clubs where slug = 'riverside');
-- Expected: 5

-- New club rows must not appear in pilot club's RLS-scoped view
-- (Run this as an authenticated pilot club member, not as postgres)
```

---

## Troubleshooting

### `slug_already_exists`

A club with that slug already exists.

```sql
select id, name, slug from clubs order by created_at;
```

Choose a different slug and rerun the script.

---

### `invalid_slug`

The slug format is invalid or the value is reserved.

**Format rules:**

- Lowercase letters, digits, and hyphens only
- Must start and end with a letter or digit
- A single alphanumeric character is valid

**Reserved slugs** (automatically rejected):
`admin`, `api`, `auth`, `join`, `sign-in`, `setup`, `operator`, `app`,
`www`, `mail`, `help`, `support`, `booking`, `dashboard`

---

### `invalid_court_count`

`p_court_count` must be between 1 and 20. Check the value in the script.

---

### `invalid_hours`

`p_closes_at` must be strictly after `p_opens_at`. Example of a broken
value: `opens_at = '20:00'` and `closes_at = '08:00'`.

---

### `invalid_operator_user`

The UUID in `p_operator_user_id` does not exist in `auth.users`.

Re-run the lookup from Step 1 and copy the correct UUID. Make sure to cast
it: `'your-uuid-here'::uuid`.

---

### Invite expired before the admin used it

The invite is valid for 14 days. If it expired, create a new one from the
Supabase SQL Editor using the existing admin's club_id (or run the bootstrap
check to see if an unused invite already exists):

```sql
-- Check existing invite status
select code, expires_at, accepted_at, revoked_at
from club_invites
where club_id = '<club_id>'
order by created_at desc
limit 5;
```

If all invites are expired or revoked, insert a new admin invite directly:

```sql
insert into club_invites (club_id, role, email, created_by, expires_at)
values (
  '<club_id>',
  'admin',
  null,
  '<operator_user_id>'::uuid,
  now() + interval '14 days'
)
returning code;
-- Build the link: https://court-time.vercel.app/join/<code>
```

---

### First admin cannot sign in (Auth user not created yet)

The invite acceptance page (`/join/<code>`) requires the user to already be
signed in. If the admin sees the sign-in page and cannot log in, their
Supabase Auth account has not been created yet.

Go to Supabase **Authentication → Users → Add user** and create the account
(see Step 4), then resend the invite link.

---

### First admin lands on `/pending-invite` instead of accepting the invite

This happens when the admin navigates to the app root or `/calendar` before
accepting the invite. Their `profiles.club_id` is still null at that point.

Direct them to the invite URL: `https://court-time.vercel.app/join/<code>`

They must accept the invite before they can access the app.

---

### First admin accepted the invite but their name is missing

They were redirected to `/welcome` after accepting. If they closed the tab,
they can return to `/welcome` or update their name from `/profile`.

---

## Defaults reference

| Setting                  | Default                 | Adjustable after setup         |
| ------------------------ | ----------------------- | ------------------------------ |
| Theme                    | `classic-gray`          | Yes — Admin Settings           |
| Logo                     | none                    | Yes — Admin Settings           |
| Operating hours          | 08:00–20:00, all 7 days | Pending operating hours editor |
| Booking window           | 14 days                 | Yes — Admin Settings           |
| Cancellation window      | 24 hours                | Yes — Admin Settings           |
| Cancellation grace       | 5 minutes               | Yes — Admin Settings           |
| Court names              | Court 1, Court 2, …     | Yes — Admin Courts             |
| Event type labels/colors | Standard defaults       | Pending event type editor      |
