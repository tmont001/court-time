# Phase 25C QA Checklist

Covers Phase 25C: Admin Membership Controls and Lesson Pro Designation.
Requires migration 0080 to be applied before testing.

---

## RPC Security — Direct Access

### 25C-1: Non-admin rejection

- [ ] Sign in as a member
- [ ] Call `supabase.rpc("set_lesson_provider_status", { p_target_user_id: adminUuid, p_enabled: true })`
- [ ] Confirm error contains "insufficient_role"

### 25C-2: Same-club enforcement

- [ ] Call `set_lesson_provider_status` with a UUID from a different club
- [ ] Confirm error contains "user_not_found"

### 25C-3: Member target rejection

- [ ] Sign in as an active admin
- [ ] Call `set_lesson_provider_status` with a Member-role user's UUID, `p_enabled: true`
- [ ] Confirm error contains "target_not_admin_role"

### 25C-4: Pro target rejection

- [ ] Sign in as an active admin
- [ ] Call `set_lesson_provider_status` with a Pro-role user's UUID, `p_enabled: true`
- [ ] Confirm error contains "target_not_admin_role"

### 25C-5: Inactive actor rejection

- [ ] Set the calling admin's status to 'inactive' in the database
- [ ] Call `set_lesson_provider_status` for a valid admin target
- [ ] Confirm error contains "inactive_actor"
- [ ] Restore the admin to 'active' status afterward

### 25C-6: Idempotent no-op — no audit entry

- [ ] Sign in as an active admin
- [ ] Note the current value of `is_lesson_provider` for an admin target
- [ ] Call `set_lesson_provider_status` with that same value (no change)
- [ ] Confirm the call returns without error
- [ ] Confirm no new audit_log entry was written for this call
- [ ] Confirm `updated_at` on the profile row was NOT changed

### 25C-7: get_admin_club_pros requires admin role

- [ ] Sign in as a Pro
- [ ] Call `supabase.rpc("get_admin_club_pros")`
- [ ] Confirm error contains "insufficient_role"

### 25C-8: get_admin_club_pros includes calling admin

- [ ] Sign in as an active admin with `is_lesson_provider = true`
- [ ] Call `supabase.rpc("get_admin_club_pros")`
- [ ] Confirm the calling admin's own UUID appears in the result
- [ ] Call `supabase.rpc("get_club_pros")` (member-facing)
- [ ] Confirm the calling admin's own UUID does NOT appear in that result

---

## Member Detail Page — Lesson Pro Section

### 25C-9: Member read-only — not eligible

- [ ] Sign in as admin
- [ ] Open /admin/members/{id} for a Member-role user
- [ ] Confirm "Lesson Pro: Not eligible (Member role)" appears as static text
- [ ] Confirm no button or toggle is present

### 25C-10: Pro read-only — automatic

- [ ] Open /admin/members/{id} for a Pro-role user
- [ ] Confirm "Lesson Pro: Enabled automatically (Pro role)" appears as static text
- [ ] Confirm no button or toggle is present

### 25C-11: Admin enable flow

- [ ] Open /admin/members/{id} for an active Admin-role user with `is_lesson_provider = false`
- [ ] Confirm "Enable Lesson Pro" button is visible
- [ ] Confirm helper text "Enables this admin to receive and manage lesson assignments." appears
- [ ] Click "Enable Lesson Pro"
- [ ] Confirm button shows "Saving…" briefly
- [ ] Confirm "Lesson Pro" badge and "Remove" link appear after save
- [ ] Confirm no page reload is required

### 25C-12: Admin disable flow

- [ ] Open /admin/members/{id} for an active Admin-role user with `is_lesson_provider = true`
- [ ] Confirm "Lesson Pro" badge and "Remove" link are visible
- [ ] Click "Remove"
- [ ] Confirm button shows "Saving…" briefly
- [ ] Confirm "Enable Lesson Pro" button reappears after save

### 25C-13: Admin self-designation

- [ ] Sign in as an active admin
- [ ] Open /admin/members/{admin_own_id}
- [ ] Confirm the Lesson Pro enable/disable control is present for own profile
- [ ] Toggle the designation → confirm it saves correctly

### 25C-14: Inactive target — designation stored but warning shown

- [ ] Set an admin target's status to 'inactive'
- [ ] Open /admin/members/{id} for that admin
- [ ] Confirm the enable/disable control is still visible (designation is storeable)
- [ ] Confirm an amber warning note appears: "...won't appear in provider selectors until their membership is Active."
- [ ] Enable or disable the designation → confirm it saves without error

### 25C-15: Duplicate submission prevention

- [ ] Click "Enable Lesson Pro" quickly twice
- [ ] Confirm only one RPC call is made (button is disabled while saving)

### 25C-16: Error display

- [ ] Simulate a network error or temporarily revoke RPC access
- [ ] Attempt to enable/disable → confirm inline error message appears below the control
- [ ] Confirm previous state is preserved (no optimistic update on error)

---

## Audit Log

### 25C-17: Audit entry written on enable

- [ ] Enable Lesson Pro for an admin user
- [ ] Open /admin/audit-log
- [ ] Confirm an entry with action "set_lesson_provider_status" appears
- [ ] Confirm metadata shows old_value: false, new_value: true

### 25C-18: Audit entry written on disable

- [ ] Disable Lesson Pro for an admin user
- [ ] Confirm audit entry with old_value: true, new_value: false

### 25C-19: No audit entry on no-op

- [ ] Note the current value of `is_lesson_provider` for an admin
- [ ] Call `set_lesson_provider_status` with the same value
- [ ] Confirm no new audit_log entry was written (same count before/after)

---

## Provider Selector Refresh — Admin Pages

### 25C-20: Enabled admin appears in admin lesson provider list

- [ ] Enable Lesson Pro for an admin user
- [ ] Navigate to /admin/lessons → Request Lesson
- [ ] Confirm the admin appears in the provider selector (sourced from get_admin_club_pros)

### 25C-21: Admin appears in own selector (self-designation)

- [ ] Sign in as an admin with `is_lesson_provider = true`
- [ ] Navigate to /admin/lessons → Request Lesson
- [ ] Confirm the currently signed-in admin appears in the selector

### 25C-22: Disabled admin removed from admin provider list

- [ ] Disable Lesson Pro for an admin who was previously a provider
- [ ] Navigate to /admin/lessons → Request Lesson
- [ ] Confirm the admin no longer appears in the selector

### 25C-23: Pro users unaffected

- [ ] After the changes above, confirm all active Pro-role users still appear in the selector
- [ ] Confirm no Pros were inadvertently removed

### 25C-24: Inactive target excluded from selector

- [ ] Set an admin target's status to 'inactive' after enabling their Lesson Pro designation
- [ ] Navigate to /admin/lessons → Request Lesson
- [ ] Confirm the inactive admin does NOT appear in the provider selector
  (get_admin_club_pros filters `status = 'active'`)

### 25C-25: Existing assigned lessons preserved

- [ ] Remove Lesson Pro from an admin who has an active/confirmed lesson assignment
- [ ] Confirm the existing lesson_request rows are NOT deleted or mutated
- [ ] Confirm historical lesson data is unchanged

---

## Member-Facing Provider Selector — Self-Exclusion Preserved

### 25C-26: Member cannot see themselves in provider list

- [ ] Sign in as a user who is a Pro (role = 'pro', is_lesson_provider = true)
- [ ] Navigate to /my-schedule → Request Lesson (member-facing flow)
- [ ] Confirm the Pro does NOT see themselves in the provider selector
  (get_club_pros continues to exclude auth.uid())

### 25C-27: Member-facing list still shows all other eligible providers

- [ ] Navigate to /my-schedule → Request Lesson
- [ ] Confirm active Pros and admin-role providers with `is_lesson_provider = true` appear
  (excluding the current user)

---

## Member List — Lesson Pro Indicator

### 25C-28: Lesson Pro badge in member list

- [ ] Open /admin/members
- [ ] Find a card for a user with `is_lesson_provider = true` (Pro or enabled Admin)
- [ ] Confirm a "Lesson Pro" badge appears in the card
- [ ] Confirm the badge uses accent color styling

### 25C-29: No badge for non-providers

- [ ] Confirm Member cards have no "Lesson Pro" badge
- [ ] Confirm Admin cards without the designation have no badge

### 25C-30: Badge shown for admin providers in list after enabling

- [ ] Enable Lesson Pro for an admin
- [ ] Refresh /admin/members
- [ ] Confirm the admin's card now shows the "Lesson Pro" badge

---

## Role-Change Synchronization

### 25C-31: Promoting member to Pro sets is_lesson_provider = true

- [ ] Find a Member in the list
- [ ] Change their role to Pro using the role dropdown
- [ ] Confirm is_lesson_provider updates to true (Lesson Pro badge appears)
- [ ] Confirm they appear in admin lesson provider selector

### 25C-32: Demoting Pro to Member clears is_lesson_provider

- [ ] Find a Pro in the list
- [ ] Change role to Member
- [ ] Confirm is_lesson_provider is now false (badge disappears)
- [ ] Confirm they no longer appear in any provider selector

### 25C-33: Admin role change does not affect designation

- [ ] Enable Lesson Pro for an admin
- [ ] Verify `is_lesson_provider` is true via direct DB query
- [ ] Confirm `set_member_role` to 'admin' (same role) leaves designation unchanged
  (set_member_role only syncs pro→true and member→false)

---

## Last-Admin Protection Regression

### 25C-34: Last active admin cannot be demoted

- [ ] Ensure only one active admin exists in the club
- [ ] Attempt to change their role to Member or Pro via the member list
- [ ] Confirm "Last admin — cannot change." message appears
- [ ] Confirm role remains 'admin'

---

## Member Directory Regression

### 25C-35: Search still works

- [ ] On /admin/members, type a partial name in the search field
- [ ] Confirm filtered results appear correctly
- [ ] Confirm the Lesson Pro badge does not interfere with row rendering

### 25C-36: Role and status filters still work

- [ ] Apply "Admin" role filter → confirm only admin members appear
- [ ] Apply "Inactive" status filter → confirm only inactive members appear

---

## Existing Lesson Tabs Regression (Phase 24)

### 25C-37: Admin lesson operations unchanged

- [ ] Navigate to /admin/lessons
- [ ] Create a lesson request on behalf of a member
- [ ] Reassign lesson to a different provider
- [ ] Confirm these operations work as before

### 25C-38: Pro lesson operations unchanged

- [ ] Sign in as a Pro
- [ ] Navigate to /admin/lessons
- [ ] Confirm Pro lesson tabs and actions load correctly

### 25C-39: Member bookings and lesson requests unchanged

- [ ] Sign in as a member
- [ ] Navigate to /my-schedule
- [ ] Confirm Upcoming, Lesson Requests, and Past tabs function correctly

---

## Mobile Layout

### 25C-40: Lesson Pro section on mobile

- [ ] View /admin/members/{id} for an Admin target on a 390px viewport
- [ ] Confirm Lesson Pro enable/disable button is tappable (minimum 44px target area)
- [ ] Confirm no horizontal overflow

### 25C-41: Inactive-target warning note on mobile

- [ ] View /admin/members/{id} for an inactive Admin target on mobile
- [ ] Confirm the amber warning note is readable and does not overflow

### 25C-42: Lesson Pro badge in member list on mobile

- [ ] View /admin/members on mobile
- [ ] Confirm Lesson Pro badge does not cause card layout to break

---

## Dark Mode

### 25C-43: Lesson Pro badge in dark mode

- [ ] Enable dark mode
- [ ] View a member with Lesson Pro designation
- [ ] Confirm "Lesson Pro" badge is readable (accent color on accent/10 background)

### 25C-44: Enable button in dark mode

- [ ] View an Admin-role member without designation in dark mode
- [ ] Confirm "Enable Lesson Pro" button border and text are visible

### 25C-45: Inactive-target warning in dark mode

- [ ] View an inactive Admin-role member in dark mode
- [ ] Confirm the amber warning note is readable
