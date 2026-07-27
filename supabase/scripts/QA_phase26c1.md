# Phase 26C1 QA Checklist — Auth Context and Admin Membership Controls

Covers Phase 26C1: migration `0083_auth_context_and_membership_controls.sql`
plus application changes to `src/lib/supabase/user.ts`, the authenticated
app/admin layouts, and `/profile`. Requires migrations `0081`/`0082` already
applied and verified.

**Scope reminder:** this checkpoint converts `getAuthProfile()`, the
authenticated app layout, the admin layout, `/profile`, and the five admin
membership RPCs (`get_members`, `get_admin_member_detail`, `set_member_role`,
`set_member_status`, `set_lesson_provider_status`) to `club_memberships` as
the authoritative source, plus one narrow RLS fix
(`lesson_requests_select_admin`). **No** club switcher exists. **No** other
page (Calendar, Events, Bookings, Lessons, Courts, Settings, audit log,
invitations) was converted — those remain correct only because migration
0081's compatibility triggers keep `profiles.club_id/role/status/
is_lesson_provider` synchronized with the active membership. Run
`supabase/scripts/verify_phase26c1.sql` first; every section should pass
before starting the manual steps here.

Each check below is labeled **[SQL]** (read-only, SQL Editor) or **[APP]**
(requires an authenticated application session — sign in as the actual
role/account described).

---

## Pre-conditions

- [ ] Migrations `0081`, `0082` applied and previously verified
- [ ] Migration `0083` applied
- [ ] `verify_phase26c1.sql` Sections A-E return no unexpected rows
- [ ] Staging/test project, not production, for every mutation step below

---

## 1. Authentication Context

### 26C1-1: Member — **[APP]**
- [ ] Sign in as an existing Member with an active membership
- [ ] Confirm landing on `/calendar`, same as before
- [ ] Confirm SideNav/BottomNav show the Member set and the correct club name
- [ ] Confirm no club switcher appears anywhere

### 26C1-2: Pro — **[APP]**
- [ ] Sign in as an existing Pro
- [ ] Confirm the Pro navigation set (including Lessons) is unchanged

### 26C1-3: Admin — **[APP]**
- [ ] Sign in as an existing Admin
- [ ] Confirm `/admin/*` routes are reachable exactly as before

### 26C1-4: No-club user — **[APP]**
- [ ] Sign in as (or create) an account with no accepted invite
- [ ] Confirm landing on `/pending-invite` (or the invite-cookie redirect),
      unchanged from before — `(app)/layout.tsx` redirects before any page
      under `(app)/`, including `/profile`, ever renders for this user in
      Phase 26C1; `/profile` is not reachable for a no-club user in this
      checkpoint
- [ ] Confirm attempting to navigate directly to `/profile` also redirects
      to `/pending-invite` (the layout gate applies regardless of entry URL)

### 26C1-5: Inactive disposable user — **[SQL] then [APP]**
- [ ] **[SQL]** Using a disposable test account with an active membership,
      set its membership to inactive:
  ```sql
  update public.club_memberships set status = 'inactive'
   where user_id = '<disposable profile id>' and club_id = '<club id>';
  ```
- [ ] **[APP]** Sign in as that disposable user
- [ ] Confirm this user fails closed the same way a no-club user does: they
      land on `/pending-invite`, and `/profile` is not reachable — this is
      the current, correct-for-26C1 behavior (`(app)/layout.tsx`'s gate
      does not distinguish "never joined" from "sole membership is
      inactive/suspended/removed"; dedicated inactive-account messaging and
      routing is deferred to Phase 26E, not this checkpoint)
- [ ] Confirm the app does not misreport this user as "Active" anywhere
- [ ] **[SQL]** Confirm database-layer own-profile access remains correct
      independent of the application gate above (migration 0082's
      `profiles_select_same_club`/`profiles_update_own_row` corrections):
      this user can still `SELECT`/`UPDATE` their own `profiles` row directly
      at the database layer even while `(app)/layout.tsx` keeps them out of
      the UI — re-run the relevant checks from `QA_phase26b2.md` §4c against
      this same disposable user if you want to confirm this empirically
- [ ] **[SQL]** Restore: `update public.club_memberships set status =
      'active' where user_id = '<disposable profile id>' and club_id =
      '<club id>';`

### 26C1-6: Active club name/theme — **[APP]**
- [ ] Confirm the club name shown in SideNav/BottomNav/header matches the
      active club, and the page theme (color scheme) matches that club's
      `theme_key` — both now sourced from `get_current_account_context()`
      directly rather than a separate `clubs` query

### 26C1-7: Role-aware navigation — **[APP]**
- [ ] Confirm Member/Pro/Admin each still see exactly their expected
      navigation set (no broadening, no narrowing)

### 26C1-8: Profile/Account membership display — **[APP]**
- [ ] For an active Member/Pro/Admin, confirm Club/Role/Status/Lesson-Pro
      (where applicable) on `/profile` match that user's actual
      `club_memberships` row — cross-check via **[SQL]**:
  ```sql
  select cm.club_id, c.name, cm.role, cm.status, cm.is_lesson_provider
  from public.club_memberships cm join public.clubs c on c.id = cm.club_id
  where cm.user_id = '<user id>' and cm.club_id = (
    select active_club_id from public.profiles where id = '<user id>'
  );
  ```

### 26C1-8b: get_current_account_context() return shape, real sessions — **[APP]**
- [ ] After `0083` is applied, sign in separately as an active Member, an
      active Pro, and an active Admin, and directly call
      `supabase.rpc("get_current_account_context").single()` (or observe it
      indirectly via `/profile` and `/admin/*` loading correctly for each)
      for each of the three sessions
- [ ] Confirm each call returns exactly one row with the expected
      `active_club_id`/`role`/`status`/`is_lesson_provider`/`club_name`/
      `club_slug`/`theme_key` for that user — this is the empirical check
      for the corrected runtime return shape (the function previously
      declared a variable typed for the full `club_memberships` row but
      selected only four columns into it, which would have failed at
      runtime the first time this RPC was actually called)

---

## 2. Admin Directory

### 26C1-9: Member list matches club_memberships — **[APP]** then **[SQL]**
- [ ] As Admin, open `/admin/members`
- [ ] **[SQL]** Cross-check the full list against:
  ```sql
  select cm.user_id, cm.role, cm.status, cm.is_lesson_provider
  from public.club_memberships cm
  where cm.club_id = '<active club id>' and cm.removed_at is null
  order by cm.role;
  ```
- [ ] Every row in the UI matches a row here, and vice versa (same set, same
      role/status/is_lesson_provider values)

### 26C1-10: Inactive members remain visible — **[APP]**
- [ ] Confirm a member with `status = 'inactive'` in `club_memberships`
      still appears in the admin directory (no status filter — matches
      current, pre-26C1 inclusive behavior)

### 26C1-11: No removed membership appears — **[SQL] then [APP]**
- [ ] **[SQL]** Soft-remove a disposable test membership:
  ```sql
  update public.club_memberships set removed_at = now(), removed_by = '<admin id>'
   where user_id = '<disposable profile id>' and club_id = '<club id>';
  ```
- [ ] **[APP]** Confirm that user no longer appears in `/admin/members`
- [ ] **[SQL]** Restore: `update public.club_memberships set removed_at =
      null, removed_by = null where user_id = '<disposable profile id>' and
      club_id = '<club id>';`

### 26C1-12: No cross-club member appears — **[SQL] then [APP]**
- [ ] **[SQL]** Confirm a member of a *different* club exists (any existing
      test club with its own members works)
- [ ] **[APP]** Confirm that other club's members never appear in this
      club's `/admin/members`, and attempting `/admin/members/<their id>`
      returns not-found (`member_not_found`), not their data

---

## 3. Admin Mutations (disposable users, staging only)

### 26C1-13: Member → Pro → Member — **[APP]** then **[SQL]**
- [ ] As Admin, change a disposable Member to Pro
- [ ] Confirm app behavior unchanged from before (role updates, is_lesson_provider becomes true)
- [ ] **[SQL]** Confirm `club_memberships.role = 'pro'` and
      `is_lesson_provider = true` for that user/club
- [ ] Change back to Member; confirm `is_lesson_provider` reverts to `false`

### 26C1-14: Admin Lesson Pro on/off — **[APP]** then **[SQL]**
- [ ] As Admin, toggle Lesson Pro designation on a disposable Admin
- [ ] **[SQL]** Confirm only `club_memberships.is_lesson_provider` changed
      for that (user, club) — no other row affected

### 26C1-15: Active → Inactive → Active — **[APP]** then **[SQL]**
- [ ] Deactivate, then reactivate, a disposable Member
- [ ] **[SQL]** Confirm `club_memberships.status` transitions correctly and
      `profiles.active_club_id` clears then restores (Trigger B, unchanged
      from 26B1)

### 26C1-16: Last-active-admin protection — **[APP]**
- [ ] With exactly one active Admin in a test club, attempt to demote or
      deactivate that Admin
- [ ] Confirm `last_admin` is rejected exactly as before

### 26C1-17: Own-role and own-status rejection — **[APP]**
- [ ] As Admin, attempt to change your own role — confirm
      `cannot_change_own_role`
- [ ] Attempt to change your own status — confirm `cannot_change_own_status`

### 26C1-18: Cross-club target rejection — **[SQL] then [APP]**
- [ ] **[SQL]** Identify a member id belonging to a *different* club
- [ ] **[APP]** As Admin of club A, attempt `set_member_role`/
      `set_member_status` against that other-club user id (via direct RPC
      call if no UI path reaches it) — confirm `user_not_found`, and confirm
      no row in any other club was touched

### 26C1-19: Membership row is authoritative — **[SQL]**
- [ ] For each mutation above, confirm the write landed on
      `club_memberships`, not `profiles`, by checking `club_memberships.
      updated_at` advanced and comparing against the audit_log entry's
      `metadata`

### 26C1-20: Legacy projection stays synchronized — **[SQL]**
- [ ] After each mutation above (while the target's `active_club_id` still
      equals this club), confirm `profiles.role`/`status`/
      `is_lesson_provider` match the new `club_memberships` values
      (Trigger A2/B from 0081, unchanged) — re-run `verify_phase26c1.sql`
      Section E1

---

## 4. No Regressions

No code changed for these areas beyond what nullable-type fixes required
(see the Phase 26C1 report) — every one of these should be **identical to
pre-0083 behavior**. No switcher UI should appear anywhere.

### 26C1-21: Calendar — **[APP]**
- [ ] Loads courts/reservations/operating hours exactly as before

### 26C1-22: Events — **[APP]**
- [ ] List/detail/join/leave/admin management unchanged

### 26C1-23: Bookings — **[APP]**
- [ ] `/my-schedule` shows the same reservations/signups as before

### 26C1-24: Lessons — **[APP]**
- [ ] Request/proposal flows and provider selector unchanged

### 26C1-25: Courts — **[APP]**
- [ ] Admin court list/management unchanged

### 26C1-26: Settings — **[APP]**
- [ ] Club settings page loads/saves exactly as before

### 26C1-27: Invitation acceptance — **[APP]** then **[SQL]**
- [ ] Fresh sign-up, accept a valid invite — same redirect/behavior as
      Phase 26B1/26B2's equivalent checks
- [ ] **[SQL]** Confirm one `club_memberships` row, `active_club_id` set,
      `get_current_account_context()`-shaped state correct (spot-check via
      `verify_phase26c1.sql` Section E)

### 26C1-28: No club switcher — **[APP]**
- [ ] Confirm no page, menu, or sheet anywhere shows a club switcher,
      membership list, or any other multi-club UI element
