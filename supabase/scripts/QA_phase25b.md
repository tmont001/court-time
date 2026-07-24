# Phase 25B QA Checklist

Covers Phase 25B: Profile Redesign and Club Identity.
No migrations. Requires migration 0079 (Phase 25A) to be applied first.

---

## Profile Page — Account Section

### 25B-1: Email display

- [ ] Sign in as any role
- [ ] Navigate to /profile
- [ ] Confirm email address appears read-only in the Account section
- [ ] Confirm there is no email edit field or edit button

---

## Profile Page — Personal Information Section

### 25B-2: Member can edit name and phone

- [ ] Sign in as a member
- [ ] Navigate to /profile → Personal Information section
- [ ] Change first name, last name, and phone → click Save
- [ ] Confirm "Saved" confirmation appears briefly
- [ ] Refresh page → confirm new values persist

### 25B-3: Phone validation

- [ ] Enter an invalid phone number (e.g. "abc") → click Save
- [ ] Confirm inline error message appears
- [ ] Confirm no network write is made

### 25B-4: Name and phone cleared to blank

- [ ] Clear first name, last name, and phone → click Save
- [ ] Confirm save succeeds (blank values are valid)
- [ ] Refresh page → confirm fields are blank

---

## Profile Page — Club Membership Section

### 25B-5: Member profile — all fields visible

- [ ] Sign in as a member with status Active
- [ ] Navigate to /profile → Club Membership section
- [ ] Confirm Club shows the club name (not "—" or blank)
- [ ] Confirm Role shows "Member"
- [ ] Confirm Status shows "Active" badge
- [ ] Confirm "Lesson Pro" designation row is NOT shown
- [ ] Confirm helper text "Role and membership status are managed by your club." appears

### 25B-6: Pro profile — Lesson Pro indicator

- [ ] Sign in as a Pro user with is_lesson_provider = true
- [ ] Navigate to /profile → Club Membership section
- [ ] Confirm Role shows "Pro"
- [ ] Confirm Designation row shows "Lesson Pro" badge
- [ ] Confirm Status shows "Active"

### 25B-7: Pro without Lesson Pro designation

- [ ] Sign in as a Pro user with is_lesson_provider = false
- [ ] Navigate to /profile → Club Membership section
- [ ] Confirm Role shows "Pro"
- [ ] Confirm no "Designation" row is visible

### 25B-8: Admin profile

- [ ] Sign in as admin
- [ ] Navigate to /profile → Club Membership section
- [ ] Confirm Role shows "Admin"
- [ ] Confirm Lesson Pro row is only shown if admin also has is_lesson_provider = true

### 25B-9: Inactive member status

- [ ] Set a test member's status to "inactive" via admin or SQL
- [ ] Sign in as that member
- [ ] Navigate to /profile → Club Membership section
- [ ] Confirm Status badge shows "Inactive" with gray styling
- [ ] Confirm the badge text is readable (not color-only)

### 25B-10: Suspended member status

- [ ] Set a test member's status to "suspended" via admin or SQL
- [ ] Sign in as that member
- [ ] Navigate to /profile → Club Membership section
- [ ] Confirm Status badge shows "Suspended" with red/warning styling
- [ ] Confirm the badge text label "Suspended" is present (not just color)

### 25B-11: Membership fields are not editable

- [ ] On /profile, confirm the Club, Role, Status, and Designation rows have no
      input fields, dropdowns, or edit icons
- [ ] Confirm clicking on these rows does nothing (they are not links or buttons)

### 25B-12: Missing club handled safely

- [ ] If a user has club_id set but the club row is missing (edge case),
      confirm Club shows "—" instead of crashing
- [ ] The rest of the page renders normally

---

## Profile Page — Preferences & Support Section

### 25B-13: Notification Preferences link

- [ ] On /profile → Preferences & Support, click "Notification Preferences"
- [ ] Confirm navigation to /profile/notifications
- [ ] Confirm the preferences form loads

### 25B-14: Account Security link

- [ ] On /profile → Preferences & Support, click "Account Security"
- [ ] Confirm navigation to /profile/security
- [ ] Confirm the change password form loads

### 25B-15: Help & Rules link

- [ ] On /profile → Preferences & Support, click "Help & Rules"
- [ ] Confirm navigation to /help

### 25B-16: Sign Out

- [ ] Click "Sign out" button at bottom of /profile
- [ ] Confirm redirect to /sign-in
- [ ] Confirm that navigating back does not re-authenticate

### 25B-17: Lesson Requests link removed

- [ ] On /profile, confirm there is no "My Lesson Requests" link or "Lessons" section
- [ ] Confirm the link previously at /my-schedule?tab=lessons is gone from this page

---

## Profile Subpage Back Navigation

### 25B-18: Notifications page back link

- [ ] Navigate to /profile/notifications
- [ ] Confirm "← Back to Account" link is visible
- [ ] Click it → confirm navigation returns to /profile

### 25B-19: Security page back link

- [ ] Navigate to /profile/security
- [ ] Confirm "← Back to Account" link is visible
- [ ] Click it → confirm navigation returns to /profile

---

## Desktop SideNav Club Name

### 25B-20: Club name appears in SideNav

- [ ] Sign in as any role on a desktop viewport (≥ 768px)
- [ ] Confirm "Court Time" appears as the primary brand name in the sidebar header
- [ ] Confirm the club name appears as a smaller secondary line below "Court Time"
- [ ] Confirm the sidebar width is unchanged

### 25B-21: Long club name truncation in SideNav

- [ ] Temporarily test with a long club name (e.g. "Riverside Tennis Club and Athletic Center")
- [ ] Confirm the name truncates with an ellipsis rather than overflowing the sidebar
- [ ] Confirm "Court Time" line is still visible and unchanged

### 25B-22: SideNav without club name (edge case)

- [ ] Confirm that if club name is unavailable, only "Court Time" appears in the header
- [ ] No blank space or broken layout

---

## Mobile More Sheet Club Name

### 25B-23: Club name in More sheet

- [ ] Sign in as any role on a mobile viewport (< 768px)
- [ ] Tap "More" in the bottom navigation bar
- [ ] Confirm club name appears below "MORE" label in the sheet header
- [ ] Confirm all existing More menu links remain unchanged

### 25B-24: Long club name truncation in More sheet

- [ ] With a long club name, confirm it truncates rather than breaking the sheet layout

### 25B-25: Member More sheet links

- [ ] As a member, open More → confirm: Profile, Notifications, Security

### 25B-26: Admin More sheet links

- [ ] As admin, open More → confirm: Overview, Members, Courts, Club Settings,
      Audit Log, Profile, Notifications, Security

---

## Dark Mode

### 25B-27: Profile page in dark mode

- [ ] Enable dark mode
- [ ] Navigate to /profile
- [ ] Confirm all section labels are readable
- [ ] Confirm Club Membership rows are visible with proper contrast
- [ ] Confirm Active status badge is readable in dark mode
- [ ] Confirm Lesson Pro badge is readable in dark mode
- [ ] Confirm the form inputs use dark backgrounds

### 25B-28: SideNav club name in dark mode

- [ ] In dark mode, confirm club name in SideNav sidebar is visible with sufficient contrast

---

## Responsive Layout

### 25B-29: Mobile profile layout at 390px

- [ ] On a 390px-wide viewport, confirm no horizontal scroll on /profile
- [ ] Confirm email truncates in the Account row rather than overflowing
- [ ] Confirm club name truncates in the Club Membership row rather than overflowing
- [ ] Confirm Personal Information form fields are full width

### 25B-30: Tablet/desktop centered layout

- [ ] On desktop, confirm profile content is centered (md:max-w-lg md:mx-auto)
- [ ] Confirm SideNav and main content area do not overlap

---

## Regression — Phase 24 Features

### 25B-31: Bookings tab in /my-schedule

- [ ] Sign in as a member
- [ ] Navigate to /my-schedule
- [ ] Confirm Upcoming, Lesson Requests, and Past tabs all render correctly
- [ ] Confirm court reservations appear in Upcoming

### 25B-32: /lessons redirect preserved

- [ ] Navigate to /lessons
- [ ] Confirm redirect to /my-schedule?tab=lessons (or equivalent)
- [ ] Confirm Lesson Requests tab is visible and functional

### 25B-33: Admin navigation unchanged

- [ ] Sign in as admin
- [ ] Confirm Overview, Calendar, Events, Lessons appear under "Main" in SideNav
- [ ] Confirm Members, Courts, Club Settings, Audit Log appear under "Club" in SideNav
- [ ] Confirm Profile appears under "Personal" in SideNav
- [ ] Confirm admin /admin/lessons page loads normally

### 25B-34: Pro navigation unchanged

- [ ] Sign in as Pro
- [ ] Confirm Calendar, Events, Lessons, Bookings, Profile in SideNav
- [ ] Confirm /admin/lessons loads for Pro

### 25B-35: Member CRM still operational

- [ ] Sign in as admin → open /admin/members/{id}
- [ ] Confirm Notes tab, Upcoming tab, History tab all load
- [ ] Add a member note → confirm it saves
- [ ] Confirm member detail page was unaffected by profile redesign
