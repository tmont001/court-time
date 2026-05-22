# Phase 14F — Admin Role, Access Management & Settings QA Checklist

Run this checklist after all Phase 14 migrations (0036–0038) are applied and
the latest build is deployed. SQL blocks run in the **Supabase SQL Editor**.
Browser steps use a signed-in admin session on the deployed app.

Mark each item **PASS** or **FAIL**. A single FAIL warrants investigation
before the phase is considered complete.

---

## Setup — collect your UUIDs

Run once before starting. Record the values; you will need them throughout.

```sql
select p.id, u.email, p.role, p.status, p.club_id
from   profiles p
join   auth.users u on u.id = p.id
order  by p.role, u.email;
```

```
ADMIN_UUID  = ________________________________   (a user with role = 'admin')
MEMBER_UUID = ________________________________   (a user with role = 'member')
CLUB_UUID   = ________________________________   (the club_id of the admin above)
```

If you need a second admin for last-admin guard tests, either use an existing
admin or promote MEMBER_UUID to admin first via the UI, then record:

```
SECOND_ADMIN_UUID = ________________________________
```

---

## Part A — Role Management

### A.1 — Admin can change a member's role to pro

```sql
begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_role('MEMBER_UUID', 'pro');
select id, role from profiles where id = 'MEMBER_UUID';
rollback;
```

- [ ] **A.1 PASS** — No error; `role = 'pro'` returned.

---

### A.2 — Admin can change a member's role to admin

```sql
begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_role('MEMBER_UUID', 'admin');
select id, role from profiles where id = 'MEMBER_UUID';
rollback;
```

- [ ] **A.2 PASS** — No error; `role = 'admin'` returned.

---

### A.3 — Admin cannot change their own role

```sql
begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_role('ADMIN_UUID', 'member');
rollback;
```

- [ ] **A.3 PASS** — `ERROR: cannot_change_own_role`

---

### A.4 — Cannot demote the last active admin

First confirm only one active admin exists:

```sql
select count(*) as active_admins
from profiles
where club_id = 'CLUB_UUID' and role = 'admin' and status = 'active';
-- Must return 1 for this test to be meaningful.
```

Then try to demote that admin (using another admin's credentials — use the
service role here since you cannot authenticate as someone else while there
is only one admin; this tests the RPC guard directly):

```sql
-- As the only admin, try to demote themselves is blocked by cannot_change_own_role.
-- To test last_admin guard, you need SECOND_ADMIN_UUID demoting ADMIN_UUID
-- when ADMIN_UUID is the only remaining active admin.

-- Promote MEMBER_UUID to admin first:
update profiles set role = 'admin' where id = 'MEMBER_UUID';

-- Now SECOND_ADMIN_UUID demotes ADMIN_UUID (this should succeed since 2 admins exist):
begin;
select set_config('request.jwt.claims',
  '{"sub":"MEMBER_UUID","role":"authenticated"}', true);
set local role authenticated;
select set_member_role('ADMIN_UUID', 'member');
rollback;

-- Set MEMBER_UUID as only admin (service role):
update profiles set role = 'member' where id = 'ADMIN_UUID';
-- MEMBER_UUID is now the only active admin.

-- Try to demote MEMBER_UUID from any other admin account:
-- (Since there's now only one admin, this will hit last_admin)
begin;
-- Using service role as proxy — or promote ADMIN_UUID back first:
update profiles set role = 'admin' where id = 'ADMIN_UUID';
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;
select set_member_role('MEMBER_UUID', 'member');  -- MEMBER_UUID is last admin → last_admin
rollback;

-- Restore:
update profiles set role = 'member' where id = 'MEMBER_UUID';
```

- [ ] **A.4 PASS** — `ERROR: last_admin` when attempting to demote the only active admin.

---

### A.5 — One of two admins can be demoted

```sql
-- Promote MEMBER_UUID to admin (service role):
update profiles set role = 'admin' where id = 'MEMBER_UUID';

begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_role('MEMBER_UUID', 'member');  -- succeeds; ADMIN_UUID still admin
select id, role from profiles where id = 'MEMBER_UUID';
rollback;

-- Restore (happens automatically via rollback):
```

- [ ] **A.5 PASS** — No error; `role = 'member'` returned. `ADMIN_UUID` remains admin.

---

### A.6 — Audit log entries for role changes

```sql
select actor_id, action, target_id, metadata, created_at
from   audit_log
where  club_id = 'CLUB_UUID'
  and  action  = 'set_member_role'
order  by created_at desc
limit  5;
```

- [ ] **A.6 PASS** — Rows present for each committed role change. `metadata` contains `old_role` and `new_role` keys.

---

### A.7 — Role selector disabled for own row (browser)

Navigate to `/admin/members`. Find your own row.

- [ ] **A.7 PASS** — Role `<select>` is grayed out and non-interactive on your own row.

---

### A.8 — Role change via UI updates the displayed role (browser)

On `/admin/members`, find a member row (not your own). Change the role selector.

- [ ] **A.8 PASS** — Role selector shows brief "Saving…" then the page refreshes with the new role displayed.

---

## Part B — Status Management

### B.1 — Admin can deactivate a member

```sql
begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_status('MEMBER_UUID', 'inactive');
select id, status from profiles where id = 'MEMBER_UUID';
rollback;
```

- [ ] **B.1 PASS** — No error; `status = 'inactive'` returned.

---

### B.2 — Admin can reactivate an inactive member

```sql
-- First, set MEMBER_UUID inactive via service role:
update profiles set status = 'inactive', updated_at = now() where id = 'MEMBER_UUID';

begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_status('MEMBER_UUID', 'active');
select id, status from profiles where id = 'MEMBER_UUID';
rollback;

-- Restore:
update profiles set status = 'active', updated_at = now() where id = 'MEMBER_UUID';
```

- [ ] **B.2 PASS** — No error; `status = 'active'` returned.

---

### B.3 — Admin cannot change their own status

```sql
begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_status('ADMIN_UUID', 'inactive');
rollback;
```

- [ ] **B.3 PASS** — `ERROR: cannot_change_own_status`

---

### B.4 — 'suspended' is not accepted by set_member_status

```sql
begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_status('MEMBER_UUID', 'suspended');
rollback;
```

- [ ] **B.4 PASS** — `ERROR: invalid_status`

---

### B.5 — Cannot deactivate the last active admin

Ensure only one active admin exists (per Part A setup), then:

```sql
-- Promote MEMBER_UUID to admin (service role):
update profiles set role = 'admin' where id = 'MEMBER_UUID';

begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_status('MEMBER_UUID', 'inactive');  -- MEMBER_UUID is the only active admin
rollback;

-- Restore:
update profiles set role = 'member' where id = 'MEMBER_UUID';
```

- [ ] **B.5 PASS** — `ERROR: last_admin`

---

### B.6 — One of two active admins can be deactivated

```sql
update profiles set role = 'admin' where id = 'MEMBER_UUID';

begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_status('MEMBER_UUID', 'inactive');  -- succeeds; ADMIN_UUID still active admin
select id, status from profiles where id = 'MEMBER_UUID';
rollback;

-- Restore:
update profiles set role = 'member', status = 'active' where id = 'MEMBER_UUID';
```

- [ ] **B.6 PASS** — No error; `status = 'inactive'` returned.

---

### B.7 — Audit log entries for status changes

```sql
select actor_id, action, target_id, metadata, created_at
from   audit_log
where  club_id = 'CLUB_UUID'
  and  action  = 'set_member_status'
order  by created_at desc
limit  5;
```

- [ ] **B.7 PASS** — Rows present for each committed status change. `metadata` contains `old_status` and `new_status` keys.

---

### B.8 — Inactive members remain visible in /admin/members (browser)

Set MEMBER_UUID inactive (service role), then navigate to `/admin/members`.

```sql
update profiles set status = 'inactive', updated_at = now() where id = 'MEMBER_UUID';
```

- [ ] **B.8 PASS** — Inactive member row is visible in the member list at reduced opacity. "Inactive" badge is shown. A "Reactivate" button is present.

Restore after checking:

```sql
update profiles set status = 'active', updated_at = now() where id = 'MEMBER_UUID';
```

---

## Part C — Inactive-User Booking/Event Enforcement

First, set MEMBER_UUID inactive:

```sql
update profiles set status = 'inactive', updated_at = now() where id = 'MEMBER_UUID';
```

### C.1 — Inactive user cannot call create_reservation

```sql
begin;
select set_config('request.jwt.claims',
  '{"sub":"MEMBER_UUID","role":"authenticated"}', true);
set local role authenticated;

select create_reservation(
  (select id from courts
   where club_id = 'CLUB_UUID' and is_active = true limit 1),
  now() + interval '1 day',
  now() + interval '1 day 1 hour'
);
rollback;
```

- [ ] **C.1 PASS** — `ERROR: account_inactive`

---

### C.2 — Inactive user cannot call join_event

```sql
begin;
select set_config('request.jwt.claims',
  '{"sub":"MEMBER_UUID","role":"authenticated"}', true);
set local role authenticated;

select join_event(
  (select id from events
   where club_id = 'CLUB_UUID' and status = 'scheduled' limit 1)
);
rollback;
```

- [ ] **C.2 PASS** — `ERROR: account_inactive`

  _(If no scheduled events exist in this club, create one via the UI or skip with note.)_

---

### C.3 — Inactive pro/admin cannot call create_event

```sql
-- Temporarily promote MEMBER_UUID to pro so the role check passes:
update profiles set role = 'pro' where id = 'MEMBER_UUID';

begin;
select set_config('request.jwt.claims',
  '{"sub":"MEMBER_UUID","role":"authenticated"}', true);
set local role authenticated;

select create_event(
  (select id from event_types where club_id = 'CLUB_UUID' limit 1),
  'QA test event',
  now() + interval '2 days',
  now() + interval '2 days 1 hour',
  array[(select id from courts where club_id = 'CLUB_UUID' and is_active = true limit 1)]
);
rollback;

-- Restore role:
update profiles set role = 'member' where id = 'MEMBER_UUID';
```

- [ ] **C.3 PASS** — `ERROR: account_inactive`

---

### C.4 — Inactive user's existing reservations/history untouched

```sql
select count(*) as reservation_count
from reservations
where owner_user_id = 'MEMBER_UUID';

select count(*) as event_participant_count
from event_participants
where profile_id = 'MEMBER_UUID';

select count(*) as audit_count
from audit_log
where actor_id = 'MEMBER_UUID';
```

- [ ] **C.4 PASS** — Row counts are unchanged from before deactivation. No data was deleted or modified.

---

### C.5 — Active user booking behavior unaffected (regression)

Restore MEMBER_UUID to active:

```sql
update profiles set status = 'active', role = 'member', updated_at = now()
where id = 'MEMBER_UUID';
```

Then attempt a booking as MEMBER_UUID. It should reach the normal validation
guards (not `account_inactive`):

```sql
begin;
select set_config('request.jwt.claims',
  '{"sub":"MEMBER_UUID","role":"authenticated"}', true);
set local role authenticated;

select create_reservation(
  (select id from courts where club_id = 'CLUB_UUID' and is_active = true limit 1),
  now() + interval '1 day',
  now() + interval '1 day 1 hour'
);
rollback;
```

- [ ] **C.5 PASS** — Error is something other than `account_inactive` (e.g., `outside_operating_hours`, `club_closed_this_day`, or success). Confirms the guard does not fire for active users.

---

## Part D — Members UI Regression (browser)

Navigate to `/admin/members` as the pilot club admin.

- [ ] **D.1 PASS** — Page loads without error.
- [ ] **D.2 PASS** — Each member row shows a green "Active" or gray "Inactive" status badge.
- [ ] **D.3 PASS** — Each member row shows a role `<select>` with the correct current role.
- [ ] **D.4 PASS** — Own row role selector is disabled (grayed out, non-interactive).
- [ ] **D.5 PASS** — Own row deactivate/reactivate button is disabled.
- [ ] **D.6 PASS** — If only one active admin exists: that row shows "Last admin — cannot change." and both controls are disabled.
- [ ] **D.7 PASS** — Changing another member's role via the selector refreshes the list with the updated role.
- [ ] **D.8 PASS** — Clicking Deactivate opens a confirmation dialog with the member's name and a note about existing reservations being preserved.
- [ ] **D.9 PASS** — Cancelling the dialog leaves status unchanged.
- [ ] **D.10 PASS** — Confirming Deactivate sets status to inactive; row dims; badge shows "Inactive".
- [ ] **D.11 PASS** — Reactivate button appears on inactive rows; clicking and confirming restores full opacity and "Active" badge.
- [ ] **D.12 PASS** — `+ Invite` button opens the InviteSheet correctly.
- [ ] **D.13 PASS** — InviteSheet generates an invite link for member/pro/admin roles.
- [ ] **D.14 PASS** — Pending Invites section renders existing pending invites.
- [ ] **D.15 PASS** — Copy Link copies the invite URL to clipboard.
- [ ] **D.16 PASS** — Revoke removes the invite from the pending list.

---

## Part E — Settings Cleanup (browser)

Navigate to `/admin/settings` as the pilot club admin.

- [ ] **E.1 PASS** — No "Court Management" section or "Manage Courts" link appears on `/admin/settings`.
- [ ] **E.2 PASS** — `/admin/courts` loads correctly and courts can be managed (add, rename, reorder, toggle active).
- [ ] **E.3 PASS** — `/profile` admin section still links to Courts correctly (navigate to profile, check the admin section).
- [ ] **E.4 PASS** — Club Branding section still present and functional.
- [ ] **E.5 PASS** — Booking Rules section still present and functional.
- [ ] **E.6 PASS** — Notifications section still present.

---

## Part F — Operating Hours Editor (browser + SQL)

### F.1 — Editor loads with current DB values

Navigate to `/admin/settings`. Scroll to Operating Hours.

- [ ] **F.1 PASS** — All 7 day rows render with the correct opens_at, closes_at, and is_closed values from the database.

---

### F.2 — Closed toggle disables time inputs

Check the "Closed" box on any day.

- [ ] **F.2 PASS** — Both time inputs for that day dim and become non-interactive while Closed is checked.

---

### F.3 — Client validation blocks invalid times

Set closes_at ≤ opens_at on an open day and click Save. Confirm in the Network
tab that no RPC request is sent.

- [ ] **F.3 PASS** — Inline error appears (e.g., "Monday: closing time must be after opening time."). No network request fires.

---

### F.4 — Valid save persists after reload

Set valid hours (e.g., change Monday to 09:00–21:00) and click Save. Reload the page.

- [ ] **F.4 PASS** — "Saved" appears briefly. After reload, Monday shows 09:00–21:00. No error.

---

### F.5 — Audit log entry for hours update

```sql
select action, target_type, target_id, metadata->'affected' as affected, created_at
from   audit_log
where  club_id = 'CLUB_UUID'
  and  action  = 'update_operating_hours'
order  by created_at desc
limit  3;
```

- [ ] **F.5 PASS** — Row(s) present from the save in F.4. `target_type = 'club_settings'`, `target_id` matches `CLUB_UUID`.

---

### F.6 — Conflict confirmation dialog appears when future reservations are affected

Find or create a future confirmed reservation (e.g., Monday at 10:00 AM). Then
in the Operating Hours editor, narrow Monday's hours to exclude that time (e.g.,
set opens_at to 11:00), and click Save.

- [ ] **F.6 PASS** — Confirmation dialog appears listing Monday with the reservation count.
- [ ] **F.7 PASS** — Dialog text includes "Existing reservations will not be cancelled or modified."

---

### F.7 — Cancel keeps hours unchanged

In the conflict dialog from F.6, click Cancel.

- [ ] **F.8 PASS** — Dialog closes. Hours not saved. Reservation unchanged.

```sql
select id, starts_at, status from reservations
where  owner_user_id = 'MEMBER_UUID'
  and  starts_at > now()
order  by starts_at;
-- Reservation still present and status = 'confirmed'.
```

---

### F.8 — Save anyway persists hours and leaves reservation untouched

Open the conflict scenario again (from F.6) and click "Save anyway".

- [ ] **F.9 PASS** — Dialog closes. "Saved" appears. Page reload shows updated hours.
- [ ] **F.10 PASS** — The future reservation is still present and `status = 'confirmed'` in the database.

```sql
select id, starts_at, status from reservations
where  owner_user_id = 'MEMBER_UUID'
  and  starts_at > now()
order  by starts_at;
```

---

### F.9 — New booking outside updated hours is rejected

After saving narrower hours for Monday, attempt to create a reservation on
Monday outside the new hours window:

```sql
-- Replace with an actual Monday timestamp outside your new hours
begin;
select set_config('request.jwt.claims',
  '{"sub":"MEMBER_UUID","role":"authenticated"}', true);
set local role authenticated;

-- Example: booking at 08:00 after setting opens_at to 11:00
select create_reservation(
  (select id from courts where club_id = 'CLUB_UUID' and is_active = true limit 1),
  date_trunc('week', now() + interval '7 days') + interval '1 day 8 hours',  -- next Monday 08:00
  date_trunc('week', now() + interval '7 days') + interval '1 day 9 hours'   -- next Monday 09:00
);
rollback;
```

- [ ] **F.11 PASS** — `ERROR: outside_operating_hours` (or `club_closed_this_day` if that day is now closed).

---

### F.10 — dry_run SQL test

```sql
begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select update_operating_hours(
  '[
    {"day_of_week":0,"opens_at":"08:00","closes_at":"20:00","is_closed":false},
    {"day_of_week":1,"opens_at":"08:00","closes_at":"20:00","is_closed":false},
    {"day_of_week":2,"opens_at":"08:00","closes_at":"20:00","is_closed":false},
    {"day_of_week":3,"opens_at":"08:00","closes_at":"20:00","is_closed":false},
    {"day_of_week":4,"opens_at":"08:00","closes_at":"20:00","is_closed":false},
    {"day_of_week":5,"opens_at":"08:00","closes_at":"20:00","is_closed":false},
    {"day_of_week":6,"opens_at":"08:00","closes_at":"20:00","is_closed":false}
  ]'::jsonb,
  true
);
rollback;
```

- [ ] **F.12 PASS** — Returns `{"dry_run": true, "affected": [...]}`. No rows written (confirm by checking `updated_at` on operating_hours rows is unchanged).

---

## Part G — Multi-Club Regression

### G.1 — Role/status changes are scoped to actor's club

Using the service role, check that set_member_role and set_member_status raise
`user_not_found` when targeting a UUID from a different club:

```sql
-- Get a profile from a DIFFERENT club (if one exists):
select id, club_id from profiles
where club_id <> 'CLUB_UUID'
limit 1;
-- Record this as OTHER_CLUB_MEMBER_UUID

begin;
select set_config('request.jwt.claims',
  '{"sub":"ADMIN_UUID","role":"authenticated"}', true);
set local role authenticated;

select set_member_role('OTHER_CLUB_MEMBER_UUID', 'pro');
rollback;
```

- [ ] **G.1 PASS** — `ERROR: user_not_found` (cross-club targeting blocked).

---

### G.2 — Operating hours changes are scoped to actor's club

After update_operating_hours runs, verify only this club's rows are touched:

```sql
select club_id, day_of_week, opens_at, closes_at, updated_at
from   operating_hours
where  club_id <> 'CLUB_UUID'
order  by updated_at desc
limit  5;
```

- [ ] **G.2 PASS** — No rows from other clubs have a recent `updated_at` timestamp matching the Phase 14E save.

---

### G.3 — Pilot club admin sees only pilot club members

Navigate to `/admin/members` as the pilot club admin.

- [ ] **G.3 PASS** — Only pilot club members appear. No members from other clubs visible.

---

### G.4 — Pilot club admin settings unaffected

Navigate to `/admin/settings` as the pilot club admin.

- [ ] **G.4 PASS** — Club name, booking rules, and operating hours are correct for the pilot club. No data leakage from other clubs.

---

## Part H — Build & Deploy

```bash
pnpm tsc --noEmit
```

- [ ] **H.1 PASS** — No TypeScript errors.

```bash
rm -rf .next
mkdir -p .next/server
NODE_OPTIONS='--max-old-space-size=4096' pnpm build
```

- [ ] **H.2 PASS** — Clean build completes with no errors. `/admin/members` and `/admin/settings` appear in the route list.

  **Note:** If local build is blocked by the known `.next` artifact instability
  (see `memory/feedback-local-dev-instability.md`), use Vercel deployment status
  as the pass condition instead: a green "Ready" deployment on the Phase 14
  commit confirms the production build is healthy.

---

## Summary Table

| #        | Section     | Check                                   | Result |
| -------- | ----------- | --------------------------------------- | ------ |
| A.1      | Role        | Member → pro                            |        |
| A.2      | Role        | Member/pro → admin                      |        |
| A.3      | Role        | Cannot change own role                  |        |
| A.4      | Role        | last_admin guard fires                  |        |
| A.5      | Role        | One of two admins can be demoted        |        |
| A.6      | Role        | Audit log with old_role/new_role        |        |
| A.7      | Role        | Own row selector disabled (browser)     |        |
| A.8      | Role        | UI role change refreshes list (browser) |        |
| B.1      | Status      | Deactivate member                       |        |
| B.2      | Status      | Reactivate member                       |        |
| B.3      | Status      | Cannot change own status                |        |
| B.4      | Status      | 'suspended' rejected                    |        |
| B.5      | Status      | last_admin guard fires                  |        |
| B.6      | Status      | One of two admins can be deactivated    |        |
| B.7      | Status      | Audit log with old_status/new_status    |        |
| B.8      | Status      | Inactive row visible in UI (browser)    |        |
| C.1      | Enforcement | Inactive → create_reservation blocked   |        |
| C.2      | Enforcement | Inactive → join_event blocked           |        |
| C.3      | Enforcement | Inactive → create_event blocked         |        |
| C.4      | Enforcement | Existing data untouched                 |        |
| C.5      | Enforcement | Active user unaffected (regression)     |        |
| D.1–D.16 | Members UI  | Full members UI regression (browser)    |        |
| E.1–E.6  | Settings    | Settings cleanup regression (browser)   |        |
| F.1–F.12 | Hours       | Operating hours editor full flow        |        |
| G.1–G.4  | Multi-club  | Cross-club scoping verified             |        |
| H.1      | Build       | pnpm tsc --noEmit                       |        |
| H.2      | Build       | Clean build                             |        |

**Phase 14F PASS** = all items above marked PASS.

---

## Cleanup after testing

If you created any test reservations or changed member roles/statuses during
the QA run, restore them:

```sql
-- Restore MEMBER_UUID to active member:
update profiles
set    role = 'member', status = 'active', updated_at = now()
where  id = 'MEMBER_UUID';

-- Restore operating hours to standard hours if changed during testing:
-- (Re-save via the editor, or run update_operating_hours with dry_run=false)
```

> Do not run cleanup queries against production data you did not deliberately
> modify.
