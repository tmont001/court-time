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

Set the following in your Vercel project → Settings → Environment Variables.
The **Exposure** column is precise on purpose — getting it wrong for a
server-only variable leaks a credential to every visitor's browser.

| Variable | Required | Exposure | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Public (browser) | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Public (browser) | Supabase anon/publishable key (not service role) |
| `NEXT_PUBLIC_APP_URL` | Yes for production | Public (browser) | No trailing slash. Also used server-side for `metadataBase`, `sitemap.xml`, and `robots.txt` (Phase 32D) — falls back to `https://court-time.app` if unset |
| `SUPABASE_SECRET_KEY` | **Yes** — the public pilot inquiry form (`/contact`) does not work without it | **Server-only — never `NEXT_PUBLIC_`** | Phase 32C. Elevated backend key (Supabase's `sb_secret_...` key model). The only caller is `src/lib/supabase/privileged.ts`, used solely to invoke `submit_pilot_inquiry`, an RPC granted to `service_role` only. If unset, pilot-inquiry submissions fail closed with a generic error — no other part of the app is affected |
| `PILOT_INQUIRY_TO_EMAIL` | No, but recommended | Configuration, not a credential — still keep it server-only (no `NEXT_PUBLIC_` prefix) | Phase 32C. Inbox that receives the "New Court Time pilot inquiry" notification. If unset, inquiries still save to `pilot_inquiries`; only the email notification is skipped |
| `PILOT_INQUIRY_HASH_SECRET` | No | **Server-only — never `NEXT_PUBLIC_`** | Phase 32C. HMACs the request's client-address header for pilot-inquiry abuse-control throttling. If unset, that specific throttle is skipped; the duplicate-email-plus-club-name safety check still applies, so no submission is ever rejected merely because this is unset |
| `RESEND_API_KEY` | No | **Server-only — never `NEXT_PUBLIC_`** | Optional — email delivery via Resend; see email note below. Also used for the pilot-inquiry operator notification (Phase 32C) |
| `TWILIO_ACCOUNT_SID` | No | Server-only | Optional — in-app notifications work without it |
| `TWILIO_AUTH_TOKEN` | No | Server-only | Optional — see SMS note below |
| `TWILIO_FROM_NUMBER` | No | Server-only | Optional — e.g. `+1xxxxxxxxxx` |

**Pilot inquiry workflow note (Phase 32C/D):** the public `/contact` form
persists to `pilot_inquiries` through a `service_role`-only RPC — there is no
`anon`-callable path. `SUPABASE_SECRET_KEY` is what makes that possible from
a signed-out visitor's request; without it, `/contact` submissions fail
closed (visitor sees a generic error, nothing is silently degraded to a
lower-privilege client). Verify after deploying: submit a real test inquiry
from an incognito window, confirm a row appears in `pilot_inquiries`, and
confirm `SUPABASE_SECRET_KEY` never appears in `.next/static/` (it shouldn't
— it's never imported by client code — but this is worth spot-checking once
per environment).

**Email note:** The app sends transactional email notifications (event join
confirmations, waitlist offers, etc.) via [Resend](https://resend.com). If
`RESEND_API_KEY` is unset, email delivery is skipped silently — in-app
notifications still work. To enable email:

1. Create a free Resend account at https://resend.com and get an API key.
2. Verify your sending domain in the Resend dashboard (or use Resend's shared
   sending domain for low-volume pilots: `onboarding@resend.dev`).
3. Add `RESEND_API_KEY=re_...` to your Vercel environment variables.
4. Integration status shows "Email — Configured" in Admin → Overview once the
   key is present.

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

### 7 — Public site SEO (Phase 32D)

- Confirm `NEXT_PUBLIC_APP_URL` is set to your real production domain (no
  trailing slash) — it drives `metadataBase`, canonical URLs, `/sitemap.xml`,
  and `/robots.txt`. If unset, these fall back to `https://court-time.app`,
  which is wrong for any other deployment.
- Spot-check `/sitemap.xml` and `/robots.txt` after deploying — the sitemap
  should list only the six public marketing pages (`/`, `/features`,
  `/pricing`, `/contact`, `/privacy`, `/terms`); robots.txt should disallow
  every authenticated/transactional path (`/calendar`, `/admin`, `/sign-up`,
  etc.).
- There is no Court Time brand/logo asset in this repo yet. The favicon
  (`src/app/icon.tsx`) is a generated placeholder monogram, and there is no
  Open Graph share image — social previews fall back to text-only metadata.
  Replace both with real brand assets in a future phase; this was a
  deliberate scope decision, not an oversight.

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

## Changing the first admin

The first admin account is provisioned via the bootstrap script and the manual
Auth-user creation in Step 4. If you need to transfer the admin role to a different
person — for example, if the initial admin changes or the club wants a different
primary contact — do this entirely through the app. No code changes, no migrations,
and no Supabase dashboard edits are required.

**Process**

1. Sign in as an existing admin.
2. Navigate to `/admin/members` → **Invite** → choose role **admin**.
3. Copy the generated invite link and send it to the new admin.
4. The new admin accepts the invite and completes the `/welcome` flow.
5. Confirm the new admin can access `/admin/members`, `/admin/courts`,
   `/admin/settings`, and `/admin/audit-log` before making any changes to the
   original admin account.
6. If the original admin should no longer have admin access, either:
   - Change their role to **member** or **pro** via `/admin/members` → role selector, or
   - Set their status to **inactive** via `/admin/members` → status selector.

**Rules**

- **Keep at least one active admin at all times.** There is no recovery path if all
  admin accounts are deactivated — you would need to update the `profiles` table
  directly in the Supabase SQL Editor to restore admin access.
- Verify the new admin has working access before deactivating or demoting the original.
- Do not attempt to change an admin's email address. There is no email-change feature
  in the app. If an admin needs a different email address, invite them with the new
  address and deactivate the old account.
- Deactivated accounts cannot book courts or join events (enforced at the RPC level),
  but they can still sign in to the app. This is expected behavior.

---

## Defaults reference

| Setting                  | Default                 | Adjustable after setup         |
| ------------------------ | ----------------------- | ------------------------------ |
| Theme                    | `classic-gray`          | Yes — Admin Settings           |
| Logo                     | none                    | Yes — Admin Settings           |
| Operating hours          | 08:00–20:00, all 7 days | Yes — Admin Settings           |
| Booking window           | 14 days                 | Yes — Admin Settings           |
| Cancellation window      | 24 hours                | Yes — Admin Settings           |
| Cancellation grace       | 5 minutes               | Yes — Admin Settings           |
| Court names              | Court 1, Court 2, …     | Yes — Admin Courts             |
| Event type labels/colors | Standard defaults       | Pending event type editor      |

---

## Post-bootstrap club configuration

After the first admin accepts the invite and signs in, complete the following
before inviting members. All steps run inside the app at the admin's own browser.

### Step A — Set branding and timezone

1. Navigate to **Account → Settings** (`/admin/settings`).
2. Under **Club Branding**:
   - Upload a logo (JPEG, PNG, or WebP, max 2 MB). Displayed in the header.
   - Choose a **theme** — `classic-gray`, `court-green`, `clay-red`, `navy-court`,
     or `slate-modern`. Preview updates live.
3. The timezone was set during bootstrap. If it needs changing, do it now in the
   SQL Editor (directly update `clubs.timezone`). No in-app timezone editor exists
   yet; see **Known pilot limitations** at the end of this document.

### Step B — Adjust courts

1. Navigate to **Account → Courts** (`/admin/courts`).
2. Rename courts to match the club's actual court names.
3. Reorder courts using the display order if needed.
4. Mark any court inactive that should not be bookable. Inactive courts do not
   appear in the calendar or booking flow.
5. Add additional courts if the count changed after bootstrap.

### Step C — Set operating hours and closures

1. Navigate to **Account → Settings → Operating Hours**.
2. Adjust opens and closes times for each day of the week.
3. Mark any full-day closure (e.g., Sunday closed) using the Is Closed toggle.
4. Add one-off date overrides for holidays or special closures in the Date
   Overrides section.

### Step D — Set booking, cancellation, and waitlist rules

1. Navigate to **Account → Settings → Booking Rules**.
2. Set **Booking window** (days in advance members can book; default: 14).
3. Set **Cancellation window** (hours before which a member must cancel;
   default: 24). Members within this window see "Cannot cancel within Nh".
4. Set **Cancellation grace** (minutes after booking during which cancellation
   is always allowed; default: 5).
5. Set **Waitlist offer window** (hours a member has to accept a waitlist offer
   before it is passed to the next member; default: 2).

### Step E — Verify event types

The bootstrap script creates five default event types:
`clinic`, `drill`, `league`, `match`, `social`.

Labels and colors for these types cannot be edited in the app yet — see
**Known pilot limitations**. The types are available immediately in the
event creation sheet.

### Step F — Invite pilot members and pros

1. Navigate to **Account → Members** (`/admin/members`).
2. Click **Invite**.
3. Choose a role:
   - **Member** — can book courts and join public events; cannot manage events.
   - **Pro** — can create and manage events and view rosters; cannot access
     Members, Courts, Settings, or Audit Log.
   - **Admin** — full access.
4. Copy the generated invite link. It expires in **14 days**.
5. Send the link and temporary credentials (if you created the Auth user manually)
   to the invitee. They will be prompted to set a name on first login.

> Repeat for each pilot member. There is no bulk invite in the current pilot.

### Step G — Configure optional SMS (Twilio)

If SMS notifications are wanted for this pilot:

1. Obtain a Twilio account SID, auth token, and `+1xxxxxxxxxx` phone number.
2. Add to Vercel → Settings → Environment Variables:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM_NUMBER`
3. Redeploy on Vercel (required for the env-var changes to take effect).
4. Verify: **Account → Overview** → System status → SMS should show **Configured**.
5. Test: **Account → Settings → Send test SMS** to your own number.
6. Members must opt in at the account level. Direct members to **Account →
   Notification Preferences** and enable SMS.

If SMS is not needed for this pilot, skip this step. In-app notifications work
without Twilio.

### Step H — Configure optional email (Resend)

If email notifications are wanted:

1. Create a Resend account at https://resend.com and obtain an API key.
2. Verify your sending domain in the Resend dashboard. For low-volume pilots
   you can use Resend's shared domain (`onboarding@resend.dev`) without
   domain verification.
3. Add `RESEND_API_KEY=re_...` to Vercel → Settings → Environment Variables.
4. Redeploy on Vercel.
5. Verify: **Account → Overview** → System status → Email should show **Configured**.

If email is not needed, skip this step. In-app notifications are always active.

### Step I — Create initial events

1. Navigate to **Events → Manage tab** (`/events?tab=manage`).
2. Click **+ Create Event**.
3. Choose event type, title, date, start time, duration, court (optional),
   capacity, and whether members can self-join (**Member joinable** toggle).
4. Click **Create**. The event appears immediately in the Upcoming tab for members.

> For admin-managed events (e.g., league matches), disable **Member joinable**
> so members cannot self-join. Add participants from the Roster sheet.

---

## Production verification

Run both scripts below before handing the app to the first client.

### 1. Schema and infrastructure check

Open `supabase/scripts/verify_production_setup.sql` in the Supabase SQL Editor
and run it against the production project.

**Expected results:**

| Check | Expected |
| ----- | -------- |
| 1 — Required tables | 16 rows, all EXISTS |
| 2 — Missing tables | 0 rows |
| 3 — Required columns | 6 rows |
| 4 — RLS enabled | 16 rows, all true |
| 5 — RLS policy counts | 16 rows, all OK |
| 6 — Realtime publication | 1 row for `notifications` |
| 7 — Required RPCs | 20 rows, all EXISTS |
| 8 — Missing RPCs | 0 rows |
| 8b — Obsolete overloads | 0 rows |
| 9 — Storage bucket | 1 row for `club-logos` |
| 10 — Migration tracking | informational only |

Any MISSING or FAIL result is a blocking issue. See that file for fix
instructions.

### 2. Lifecycle static regression check

Open `supabase/scripts/test_lifecycle_regression.sql` in the SQL Editor and
run it against the production project.

**Expected results:**
- Section A: 16 rows, all `OK — RLS enabled`
- Section B: 2 rows, both `OK — exists` (`current_user_club_id`,
  `current_user_role`)
- Section C: 17 rows, all `OK — SECURITY DEFINER`
- Section D: 5 rows, all `OK — event_archived guard present`;
  decline guard order check returns OK
- Sections E–G: all OK; 0 MISSING rows

Section H is a manual test guide requiring real event UUIDs. Run it separately
with a test session after confirming the static checks pass.

### 3. Production smoke test

Complete the checklist in **`supabase/scripts/QA_phase21.md`** under
**"Pilot Readiness — Production Smoke-Test Checklist"** (near the end of
the file). All items must be checked before handing the app to clients.

---

## Pausing or rolling back the pilot

There is no automated rollback mechanism. If a serious problem is found after
pilot launch, use the following options in order of severity.

### Option 1 — Pause member access (no data loss)

Update the affected member's `profiles.status` to `'inactive'` directly in
the Supabase SQL Editor:

```sql
update profiles
set status = 'inactive'
where email = 'member@example.com';
-- Or by UUID: where id = '<profile-uuid>';
```

Inactive members cannot book courts or join events but can still sign in.
This is reversible: set `status = 'active'` to restore access.

### Option 2 — Disable all member access

Mark all non-admin members inactive in one statement:

```sql
update profiles
set status = 'inactive'
where club_id = '<club-uuid>'
  and role = 'member';
-- Restore with: update profiles set status = 'active' where club_id = '<club-uuid>' and role = 'member';
```

### Option 3 — Roll back a specific migration

If a migration introduced a defect that must be reverted:

1. Do not run the migration again.
2. Write a corrective SQL statement and test it in the SQL Editor.
3. Apply the corrective SQL as a new timestamped migration file.
4. Do **not** use `DROP TABLE` or delete production data without a backup.

### Option 4 — Revert a Vercel deployment

In the Vercel dashboard → Deployments, promote the last known-good deployment
to production. This reverts the frontend immediately; database schema is
unchanged.

---

## Admin quick-reference

This section is a brief reference for the first admin after onboarding is
complete. It is not a full user guide.

### Navigation

| Destination | How to get there |
| ----------- | ---------------- |
| Calendar | Bottom nav / side nav → **Calendar** |
| Events (upcoming) | Bottom nav / side nav → **Events** → Upcoming tab |
| Events (manage) | Bottom nav / side nav → **Events** → Manage tab |
| My bookings | Bottom nav / side nav → **Bookings** |
| Members | Account → Members |
| Courts | Account → Courts |
| Settings | Account → Settings |
| Overview | Account → Overview |
| Audit Log | Account → Audit Log |
| Notifications | Account → Notification Preferences |

### Common admin tasks

**Create an event:**
Events → Manage tab → **+ Create Event** → fill in type, title, date, time,
court, capacity → Create.

**View and manage roster:**
Events → Manage tab → event card → **Roster** → add/remove participants,
add guests, promote waitlisted members, adjust offers.

**Cancel an event:**
Events → Manage tab → event card → **Cancel Event** → confirm. All
confirmed and waitlisted members receive an in-app notification (and SMS/email
if configured). Linked court reservations are also cancelled.

**Archive a past event:**
Events → Manage tab → switch View to **All** or filter to past events →
event card → **Archive**. Archived events disappear from member-facing views
but roster history is preserved. Use **Unarchive** to restore.

**Invite a new member:**
Account → Members → **Invite** → choose role → copy link → send to member.

**Change a member's role or status:**
Account → Members → find member → use the Role or Status selector.

**Update booking rules:**
Account → Settings → Booking Rules → adjust values → Save.

**Update operating hours:**
Account → Settings → Operating Hours → adjust day-by-day → Save.

**Add a date override (holiday closure):**
Account → Settings → Date Overrides → **Add override** → set date and mark
as closed or set alternate hours.

**Check delivery failures:**
Account → Overview → System status → Delivery failures (48 h). A non-zero
count means some notification delivery attempts failed; investigate in
Supabase → Table Editor → `notification_deliveries`.

**Send an announcement:**
Not available in the app UI. Use a direct Supabase RPC call or a future
admin messaging feature (deferred).

---

## Support checklist

Use this section when a pilot member or operator reports a problem. Each item
references the real route, table, or SQL to check.

---

### User cannot sign in

1. Confirm the email address matches `auth.users` in Supabase → Authentication.
2. If the Auth account doesn't exist, create it in Authentication → Users →
   Add user.
3. If the password is wrong, use **Forgot password** at `/forgot-password`
   (email must exist in Auth).
4. If the user can sign in but lands on `/pending-invite`, their `profiles.club_id`
   is null — they have not accepted an invite yet. Send them the invite URL.

---

### Invitation link fails

1. Check invite status:
   ```sql
   select code, role, expires_at, accepted_at, revoked_at
   from club_invites
   where club_id = '<club-uuid>'
   order by created_at desc;
   ```
2. If `expires_at` is in the past, create a new invite from Account → Members
   → Invite, or insert one directly (see **Troubleshooting → Invite expired**
   above).
3. If `accepted_at` is not null, the invite was already used. Create a fresh one.
4. If `revoked_at` is not null, the invite was cancelled. Create a fresh one.
5. Confirm the user's Auth account exists before resending (see **User cannot
   sign in** above).

---

### User has no club (lands on /pending-invite)

The user's `profiles.club_id` is null, meaning they have not accepted a valid
invite.

```sql
select id, role, club_id from profiles where id = '<user-uuid>';
```

If `club_id` is null, send the user a valid invite link. Do not set
`club_id` directly — always go through the invite acceptance flow to ensure
the profile is fully populated.

---

### No courts appear in the calendar

1. Confirm courts exist and are active:
   ```sql
   select name, is_active from courts where club_id = '<club-uuid>' order by display_order;
   ```
2. If no rows: the bootstrap script may not have run, or courts were deleted.
   Create courts via Account → Courts.
3. If courts exist but `is_active = false`: activate them in Account → Courts.
4. Confirm operating hours exist (7 rows per club):
   ```sql
   select day_of_week, opens_at, closes_at, is_closed from operating_hours
   where club_id = '<club-uuid>' order by day_of_week;
   ```
5. If today's day is marked `is_closed = true`, no slots appear — expected
   behavior.

---

### Booking is unavailable

Possible causes:
- **Outside booking window:** The slot is more than `booking_window_days` in
  the future. Check Account → Settings → Booking Rules.
- **Outside operating hours:** The slot is before `opens_at` or after
  `closes_at`. Check Account → Settings → Operating Hours.
- **Date override is closed:** A one-off closure covers the date. Check
  Account → Settings → Date Overrides.
- **Court is inactive:** See **No courts appear** above.
- **Member is inactive:** Inactive members cannot book. Check the member's
  status in Account → Members.

---

### Event is missing from the Upcoming list

1. Confirm the event exists and is scheduled and not archived:
   ```sql
   select id, title, status, archived_at, member_joinable, starts_at
   from events
   where club_id = '<club-uuid>'
   order by starts_at desc;
   ```
2. If `archived_at IS NOT NULL`: the event is archived. Unarchive it from
   Events → Manage → View: Archived.
3. If `status = 'cancelled'`: the event was cancelled. You can create a
   replacement event.
4. If `member_joinable = false`: the event is admin-managed and intentionally
   hidden from the Upcoming list. Use the Manage tab to add members directly.
5. If `starts_at` is in the past: the event has already started and will not
   appear in Upcoming.

---

### Member cannot join an event

1. **Event is full:** Check capacity vs confirmed count in Events → Manage →
   Roster. If full, the member will be added to the waitlist automatically.
2. **Event is admin-managed (`member_joinable = false`):** Add the member
   from Events → Manage → Roster → Add member.
3. **Member is inactive:** Check Account → Members → member status.
4. **Booking rules block it:** Some join RPCs respect the `cancellation_window`
   (members cannot join after the event has started). Check the event
   `starts_at`.

---

### Waitlist offer appears stale

Offers expire after `waitlist_offer_window_hours` (default: 2 hours). After
expiry, the system should auto-advance to the next waitlisted member.

1. Check the offer in `event_participants`:
   ```sql
   select profile_id, status, offer_expires_at
   from event_participants
   where event_id = '<event-uuid>' and status = 'offered';
   ```
2. If `offer_expires_at` is in the past and the member still shows `offered`,
   run `admin_expire_offer` from Events → Manage → Roster → Expire offer, or
   call the RPC directly:
   ```sql
   select admin_expire_offer('<event-uuid>', '<profile-uuid>');
   ```
3. If the offer has not advanced to the next waitlisted member, check whether
   `advance_waitlist_offer` was invoked. The auto-advance is triggered inside
   `admin_expire_offer` and `decline_waitlist_offer` — it is not a background
   scheduler.

---

### Notification did not arrive (in-app)

1. Confirm the notification exists:
   ```sql
   select id, kind, read_at, created_at from notifications
   where profile_id = '<user-uuid>'
   order by created_at desc limit 10;
   ```
2. If notifications exist: the bell should show the count. Ask the user to
   refresh the page. Real-time updates require the `notifications` table to be
   in the `supabase_realtime` publication (check 6 in `verify_production_setup.sql`).
3. If the `supabase_realtime` publication is missing, run:
   ```sql
   alter publication supabase_realtime add table notifications;
   ```
4. If notifications do not exist at all, check that the triggering RPC (e.g.,
   `cancel_event`, `accept_waitlist_offer`) actually succeeded. Check
   `notification_deliveries` for delivery attempts.

---

### SMS or email notification did not arrive

1. Check delivery status:
   ```sql
   select channel, status, error_message, created_at
   from notification_deliveries
   where profile_id = '<user-uuid>'
   order by created_at desc limit 10;
   ```
2. If `status = 'failed'` and `error_message` is not null: the channel
   returned an error. Common causes:
   - **SMS:** Twilio account balance exhausted, invalid `FROM` number, unverified
     recipient number (trial accounts only).
   - **Email:** Resend domain not verified, API key expired or revoked,
     recipient address rejected.
3. If no rows at all: the notification may not have been triggered, or delivery
   was skipped because the member's notification preferences disabled that kind.
   Check `notification_preferences` for the member.
4. Confirm channel is configured: **Account → Overview → System status**.
   If SMS shows "Not configured", Twilio env vars are missing from Vercel.

---

### SMS or email is not configured

1. Check that the required env vars are set in Vercel → Settings →
   Environment Variables.
   - SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
   - Email: `RESEND_API_KEY`
2. After adding env vars, **redeploy** on Vercel (env vars do not take effect
   until the next deployment).
3. After redeploy, **Account → Overview → System status** should show
   **Configured** for each channel.
4. Send a test SMS from **Account → Settings → Send test SMS** to confirm
   delivery end-to-end.

---

### Vercel deployed the wrong commit

1. In the Vercel dashboard → Deployments, identify the deployment for the
   intended commit (check git SHA).
2. Use the **Promote to Production** button on the correct deployment.
3. Verify the production URL shows the expected version.

---

### Supabase migration or function is missing

1. Run `supabase/scripts/verify_production_setup.sql` — the **Missing RPCs**
   check (section 8) and **Missing tables** check (section 2) will identify gaps.
2. To apply a missing migration manually:
   - Open the migration SQL file in `supabase/migrations/`.
   - Paste its contents into the Supabase SQL Editor.
   - Run and verify no errors.
3. To confirm a specific function exists:
   ```sql
   select routine_name from information_schema.routines
   where routine_schema = 'public' and routine_name = '<function-name>';
   ```
4. If a function exists but behaves incorrectly, reapply the migration
   (`CREATE OR REPLACE FUNCTION` is safe to re-run for most migrations in
   this codebase).

---

## Known pilot limitations

The following features are not yet available in the pilot build. They are
intentionally deferred and do not affect core booking or event functionality.

| Feature | Status | Notes |
| ------- | ------ | ----- |
| Event type label/color editor | Deferred | 5 default types created by bootstrap |
| Timezone change in-app | Deferred | Change via SQL: `update clubs set timezone = 'America/Chicago' where id = '<uuid>'` |
| Bulk member import | Deferred | Invite members one at a time via Account → Members |
| Admin broadcast / announcement | Deferred | No in-app messaging; use external channel |
| Per-member SMS opt-in UI | Deferred | Members set notification preferences; SMS opt-in hidden until Twilio is confirmed |
| Waitlist auto-promotion toggle | Deferred | Current mode: offer-and-confirm (member must accept); auto-promote variant deferred |
| Self-service club signup | Deferred | Clubs are bootstrapped manually by the operator |
| Email address change | Deferred | Create a new Auth user with the new email; invite via Members |
| Public event embed | Deferred | No public-facing embed or landing page |
| Payments / billing | Deferred | Not in scope for pilot |
