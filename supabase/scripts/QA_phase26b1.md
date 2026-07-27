# Phase 26B1 QA Checklist — Club Membership Compatibility Foundation

Covers Phase 26B1: migration `0081_club_membership_compatibility_foundation.sql`.

**Scope reminder:** 0081 is purely additive. `current_user_club_id()`,
`current_user_role()`, every existing RLS policy, every existing RPC body,
`getAuthProfile`, layouts, and application code are all unmodified. Every
check below is about confirming *nothing changed* for existing single-club
behavior, plus confirming the new `club_memberships` table and
`profiles.active_club_id` are being kept correctly in sync in the
background.

**Do not test multi-club switching in this checklist** — there is no
`set_active_club`, no switcher UI, and no way for a user to hold two
memberships yet (Phase 26D). Any multi-membership state referenced below is
created directly in SQL for verification purposes only, not through the
product.

Run `supabase/scripts/verify_phase26b1.sql` first — every check in Sections
A and B should pass before starting the manual steps here.

---

## Pre-conditions

- [ ] Migration `0081_club_membership_compatibility_foundation.sql` applied
- [ ] `verify_phase26b1.sql` Sections A and B return no unexpected rows
- [ ] Staging/test project, not production, for the disposable-user test

---

## Existing Sign-In — No Behavior Change

### 26B1-1: Existing Member sign-in

- [ ] Sign in as an existing Member
- [ ] Confirm redirect to `/calendar` as before
- [ ] Confirm SideNav/BottomNav show the Member navigation set, unchanged
- [ ] Confirm the club name in the header is unchanged

### 26B1-2: Existing Pro sign-in

- [ ] Sign in as an existing Pro
- [ ] Confirm the Pro navigation set (including Lessons) is unchanged
- [ ] Confirm no new UI element (switcher, membership list, etc.) appears
      anywhere — none should exist yet

### 26B1-3: Existing Admin sign-in

- [ ] Sign in as an existing Admin
- [ ] Confirm `/admin/*` routes are reachable exactly as before
- [ ] Confirm no new UI element appears

---

## Core Pages — Unchanged Behavior

### 26B1-4: Calendar

- [ ] Calendar loads courts, reservations, and operating hours for the
      correct (single) club, exactly as before

### 26B1-5: Events

- [ ] Events list/detail/join/leave behave exactly as before

### 26B1-6: Bookings / My Schedule

- [ ] `/my-schedule` shows the same reservations and event signups as before

### 26B1-7: Lessons

- [ ] Lesson request/proposal flows behave exactly as before
- [ ] Lesson Pro provider selector shows the same set of pros as before

### 26B1-8: Members (admin)

- [ ] Admin member directory lists the same members, same roles/statuses, as
      before

### 26B1-9: Settings (admin)

- [ ] Club settings page loads and saves exactly as before

---

## Legacy Writer -> Membership Sync (read-only confirmation via SQL)

For each of the following, perform the existing product action, then run the
paired SQL query in the SQL Editor to confirm `club_memberships` picked up
the change. These are **read-only confirmation queries** — the mutation is
the existing product action itself (already covered by change-management for
the RPC in question), not a new write introduced by this checklist.

### 26B1-10: Role change sync

- [ ] As an Admin, change a Member's role to Pro via the existing admin UI
- [ ] Confirm the app behaves exactly as it does today (no visible change)
- [ ] Run:
  ```sql
  select p.id, p.role as profile_role, cm.role as membership_role,
         p.is_lesson_provider as profile_provider,
         cm.is_lesson_provider as membership_provider
  from public.profiles p
  join public.club_memberships cm on cm.user_id = p.id and cm.club_id = p.club_id
  where p.id = '<target user id>';
  ```
- [ ] Confirm `profile_role = membership_role` and
      `profile_provider = membership_provider` (Pro role syncs
      `is_lesson_provider = true` per the existing `set_member_role` logic,
      unchanged by 0081)

### 26B1-11: Lesson Pro designation sync

- [ ] As an Admin, toggle Lesson Pro status on another Admin via the existing
      admin UI
- [ ] Confirm the app behaves exactly as it does today
- [ ] Run the same query as 26B1-10 and confirm
      `profile_provider = membership_provider`

---

## Status Deactivate / Reactivate Sync — Disposable User

**Use a disposable test account only — never a real member.** Create one via
normal sign-up + invite acceptance in staging, note its `id`, and discard it
afterward.

### 26B1-12: Deactivate

- [ ] As an Admin, deactivate the disposable user via the existing admin UI
      (`set_member_status(..., 'inactive')`)
- [ ] Confirm the app behaves exactly as it does today (deactivated user is
      blocked from booking/joining, as before)
- [ ] Run:
  ```sql
  select p.id, p.status as profile_status, p.active_club_id,
         cm.status as membership_status, cm.removed_at
  from public.profiles p
  join public.club_memberships cm on cm.user_id = p.id and cm.club_id = p.club_id
  where p.id = '<disposable user id>';
  ```
- [ ] Confirm `membership_status = 'inactive'` and `active_club_id is null`
- [ ] Confirm `profile_status` is still `'inactive'` (legacy field
      deliberately preserved, not erased — this is what lets the existing
      admin UI find and reactivate the user)

### 26B1-13: Reactivate

- [ ] As an Admin, reactivate the same disposable user
      (`set_member_status(..., 'active')`)
- [ ] Confirm the app behaves exactly as it does today
- [ ] Re-run the query from 26B1-12
- [ ] Confirm `membership_status = 'active'`, `active_club_id` is set back to
      the club, and `profile_status = 'active'`

---

## New No-Club Account

### 26B1-14: Fresh sign-up, no invite yet

- [ ] Sign up a brand-new account, do not accept any invite
- [ ] Confirm the same landing behavior as today (pending-invite screen)
- [ ] Run:
  ```sql
  select id, club_id, role, status, active_club_id
  from public.profiles where id = '<new user id>';
  ```
- [ ] Confirm `club_id is null`, `status = 'active'` (current default,
      unchanged), `active_club_id is null`
- [ ] Confirm **no** `club_memberships` row exists yet for this user:
  ```sql
  select count(*) from public.club_memberships where user_id = '<new user id>';
  -- expect 0
  ```

---

## Existing Invitation Acceptance After 0081

### 26B1-15: Accept an invite (new user)

- [ ] From the account created in 26B1-14, accept a valid invite via
      `/join/<code>`
- [ ] Confirm the app behaves exactly as it does today (redirect to
      `/welcome` or `/calendar` as appropriate, no new UI)
- [ ] Run:
  ```sql
  select p.club_id, p.role, p.active_club_id,
         cm.club_id as membership_club_id, cm.role as membership_role,
         cm.status, cm.removed_at
  from public.profiles p
  join public.club_memberships cm on cm.user_id = p.id
  where p.id = '<user id>';
  ```
- [ ] Confirm exactly one `club_memberships` row exists
- [ ] Confirm `membership_club_id = p.club_id`, `membership_role = p.role`
- [ ] Confirm `active_club_id = p.club_id` (auto-assigned since this is the
      user's only, active membership)
- [ ] Confirm `status = 'active'`, `removed_at is null`

### 26B1-16: Already-in-a-club invite rejection unchanged

- [ ] As a user who already belongs to a club, attempt to open a second
      club's invite link
- [ ] Confirm the existing "Already connected... Each account belongs to one
      club" screen still appears exactly as before (0081 does not touch
      `accept_club_invite`, so `already_in_club` still fires)

---

## Backfill Spot-Checks (production data, read-only)

### 26B1-17: Active-status profile

- [ ] Pick any existing profile with `status = 'active'` and a `club_id`
- [ ] Confirm `active_club_id = club_id`
- [ ] Confirm a matching `club_memberships` row exists with
      `status = 'active'`, `removed_at is null`

### 26B1-18: Inactive-status profile (if any exist)

- [ ] Pick any existing profile with `status = 'inactive'` (if none exist in
      this environment, skip and note it)
- [ ] Confirm `active_club_id is null`
- [ ] Confirm the `club_memberships` row exists with `status = 'inactive'`
- [ ] Confirm `profiles.club_id` still shows the club (legacy field
      preserved — this is what lets an Admin find and reactivate them today)

---

## Navigation & Permissions — No Change

### 26B1-19: Single-club navigation and permissions unaffected

- [ ] Confirm Member/Pro/Admin route guards behave identically to
      pre-0081 for all three roles
- [ ] Confirm no page shows a club switcher, membership list, or any other
      new multi-club UI element (none exists yet — this is expected)

---

## Trigger Cascade — Disposable-User Transactional Test

This is the one part of this checklist that mutates data directly via SQL,
and it must **always roll back** — never commit. Run this in a scratch/
staging project, not production, and never against a real member.

**Purpose:** directly exercise the profiles -> club_memberships ->
profiles cascade described in the Phase 26B1 report's recursion-termination
proof, and confirm it terminates and produces the expected end state, without
touching any real data.

### Preparation (outside the transaction, done once)

- [ ] Create a disposable account through Supabase Authentication (or the
      normal `/sign-up` flow) — do **not** hand-insert a row into
      `auth.users` or `public.profiles`. `handle_new_user` creates the
      `profiles` row automatically, exactly as it does for a real signup.
- [ ] Confirm the profile exists and is in the expected fresh, no-club state:
  ```sql
  select id, club_id, role, status, active_club_id
  from public.profiles
  where id = '<disposable profile id>';
  ```
- [ ] Confirm `club_id is null`
- [ ] Confirm `active_club_id is null`
- [ ] Record the profile `id` — it is used throughout the block below

### Rollback test

The block below starts with an explicit guard: it aborts immediately,
before any mutation, if the supplied id does not resolve to an existing,
no-club profile. Never remove or weaken this guard, and never substitute a
real member's id.

```sql
begin;

-- GUARD — never remove. Aborts the entire transaction before any mutation
-- if the supplied id is not an existing, no-club disposable profile.
do $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile
    from public.profiles
   where id = '<disposable profile id>';

  if not found then
    raise exception 'guard_failed: no profile found for the supplied id — '
      'create the disposable account first (see Preparation above)';
  end if;

  if v_profile.club_id is not null then
    raise exception 'guard_failed: profile already belongs to a club — '
      'this must be a fresh no-club disposable account, not a real member';
  end if;

  if v_profile.active_club_id is not null then
    raise exception 'guard_failed: profile already has an active_club_id — '
      'this must be a fresh no-club disposable account';
  end if;
end;
$$;

-- Guard passed: the supplied id is confirmed to be an existing, no-club
-- profile. Simulate accept_club_invite's own UPDATE (unchanged by 0081)
-- against a real club_id already present in this staging project.
update public.profiles
   set club_id = (select id from public.clubs limit 1),
       role    = 'member'
 where id = '<disposable profile id>';

-- Expect: exactly one club_memberships row, active_club_id set to that club.
select p.id, p.club_id, p.active_club_id, p.role, p.status,
       cm.club_id as membership_club_id, cm.role as membership_role,
       cm.status as membership_status
from public.profiles p
join public.club_memberships cm on cm.user_id = p.id
where p.id = '<disposable profile id>';

-- Simulate set_member_status(..., 'inactive') (unchanged by 0081).
update public.profiles
   set status = 'inactive'
 where id = '<disposable profile id>';

-- Expect: active_club_id now NULL; profiles.club_id/role still present
-- (transitional legacy fields preserved); club_memberships.status =
-- 'inactive'.
select p.id, p.club_id, p.active_club_id, p.status,
       cm.status as membership_status
from public.profiles p
join public.club_memberships cm on cm.user_id = p.id
where p.id = '<disposable profile id>';

-- Simulate set_member_status(..., 'active') again (reactivation).
update public.profiles
   set status = 'active'
 where id = '<disposable profile id>';

-- Expect: active_club_id restored to the club; membership.status = 'active'.
select p.id, p.club_id, p.active_club_id, p.status,
       cm.status as membership_status
from public.profiles p
join public.club_memberships cm on cm.user_id = p.id
where p.id = '<disposable profile id>';

-- Always roll back. Never commit this test.
rollback;
```

- [ ] The guard did not raise `guard_failed` (if it did, stop — the supplied
      id is not a valid disposable no-club account; do not proceed)
- [ ] First `select` (post invite-accept simulation) shows exactly one
      membership row, `active_club_id` set correctly
- [ ] Second `select` (post deactivation) shows `active_club_id is null`,
      legacy `club_id`/`role` still populated, `membership_status =
      'inactive'`
- [ ] Third `select` (post reactivation) shows `active_club_id` restored,
      `membership_status = 'active'`

### After rollback

The disposable profile **existed before this transaction** (it was created
in the Preparation step, outside the transaction) — it is expected to still
exist after `rollback`. What must be undone is everything the transaction
itself did: the club/role assignment and the membership row.

- [ ] Confirm the profile still exists and is back in its original no-club
      state:
  ```sql
  select id, club_id, role, status, active_club_id
  from public.profiles
  where id = '<disposable profile id>';
  -- expect: club_id NULL, active_club_id NULL, status 'active' (original)
  ```
- [ ] Confirm no `club_memberships` row remains for this profile:
  ```sql
  select count(*) from public.club_memberships where user_id = '<disposable profile id>';
  -- expect 0
  ```
