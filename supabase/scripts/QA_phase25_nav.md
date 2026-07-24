# Phase 25 Navigation Parity QA

Covers the bounded navigation-parity correction: Admin desktop SideNav now
includes Bookings after Lessons in the Main group.

---

## Desktop SideNav — Member

### NAV-1: Member Main group

- [ ] Sign in as a Member
- [ ] Confirm desktop SideNav contains: Calendar, Events, Bookings, Profile
- [ ] Confirm Lessons is NOT present in the Member SideNav

### NAV-2: Member no operational Lessons

- [ ] Confirm there is no link to /admin/lessons for a Member

---

## Desktop SideNav — Pro

### NAV-3: Pro destinations

- [ ] Sign in as a Pro
- [ ] Confirm desktop SideNav contains: Calendar, Events, Lessons, Bookings, Profile
- [ ] Confirm Lessons links to /admin/lessons
- [ ] Confirm Bookings links to /my-schedule

---

## Desktop SideNav — Admin

### NAV-4: Admin Main group includes Bookings

- [ ] Sign in as an Admin
- [ ] Confirm desktop SideNav Main group contains: Overview, Calendar, Events, Lessons, Bookings
- [ ] Confirm Bookings appears after Lessons
- [ ] Confirm Bookings links to /my-schedule

### NAV-5: Admin Club group unchanged

- [ ] Confirm Club group contains: Members, Courts, Club Settings, Audit Log
- [ ] Confirm no duplication of any link

### NAV-6: Admin Personal group unchanged

- [ ] Confirm Personal group contains: Profile

---

## Mobile Bottom Navigation — Member

### NAV-7: Member bottom tabs

- [ ] Sign in as a Member on a 390px viewport (or browser narrow)
- [ ] Confirm bottom bar contains: Calendar, Events, Bookings, More
- [ ] Confirm Lessons tab is NOT present

### NAV-8: Member More sheet

- [ ] Tap More
- [ ] Confirm sheet contains: Profile, Notifications, Security
- [ ] Confirm Lessons is NOT present in the More sheet

---

## Mobile Bottom Navigation — Pro

### NAV-9: Pro bottom tabs

- [ ] Sign in as a Pro on mobile
- [ ] Confirm bottom bar contains: Calendar, Events, Lessons, Bookings, More
- [ ] Confirm both Lessons (/admin/lessons) and Bookings (/my-schedule) are present
- [ ] Confirm no overflow or layout break at 390px

### NAV-10: Pro More sheet

- [ ] Tap More
- [ ] Confirm sheet contains: Profile, Notifications, Security

---

## Mobile Bottom Navigation — Admin

### NAV-11: Admin bottom tabs include Bookings

- [ ] Sign in as an Admin on mobile
- [ ] Confirm bottom bar contains: Calendar, Events, Lessons, Bookings, More
- [ ] Confirm Bookings links to /my-schedule
- [ ] Confirm no overflow or layout break at 390px

### NAV-12: Admin More sheet

- [ ] Tap More
- [ ] Confirm sheet contains: Overview, Members, Courts, Club Settings, Audit Log, Profile, Notifications, Security

---

## Active-State Highlighting

### NAV-13: /my-schedule highlights Bookings

- [ ] Navigate to /my-schedule
- [ ] Confirm Bookings tab/link is highlighted (accent color)
- [ ] Confirm no other tab is simultaneously highlighted

### NAV-14: /admin/lessons highlights Lessons

- [ ] Navigate to /admin/lessons
- [ ] Confirm Lessons tab/link is highlighted
- [ ] Confirm Bookings is NOT highlighted

### NAV-15: /events highlights Events

- [ ] Navigate to /events
- [ ] Confirm Events is highlighted
- [ ] Confirm Bookings and Lessons are NOT highlighted

### NAV-16: /calendar highlights Calendar

- [ ] Navigate to /calendar
- [ ] Confirm Calendar is highlighted
- [ ] Confirm no other tab is highlighted

### NAV-17: /profile highlights Profile

- [ ] Sign in as Admin
- [ ] Navigate to /profile (desktop SideNav)
- [ ] Confirm Profile is highlighted in the Personal group
- [ ] Confirm Bookings in the Main group is NOT highlighted

---

## /lessons Redirect Regression

### NAV-18: /lessons redirects members to /my-schedule?tab=lessons

- [ ] Sign in as a Member
- [ ] Navigate directly to /lessons
- [ ] Confirm redirect to /my-schedule?tab=lessons
- [ ] Confirm the Lesson Requests tab is selected

### NAV-19: /lessons redirect preserves ?request=1

- [ ] Navigate to /lessons?request=1
- [ ] Confirm redirect to /my-schedule?tab=lessons&request=1

---

## /my-schedule Tabs Regression

### NAV-20: Upcoming tab

- [ ] Sign in as a Member
- [ ] Navigate to /my-schedule
- [ ] Confirm Upcoming tab is present and loads court reservations and confirmed events

### NAV-21: Lesson Requests tab

- [ ] Click the Lesson Requests tab on /my-schedule
- [ ] Confirm it loads the member's lesson request list

### NAV-22: Past tab

- [ ] Click the Past tab on /my-schedule
- [ ] Confirm it loads past activity

### NAV-23: Admin /my-schedule access

- [ ] Sign in as an Admin
- [ ] Navigate to /my-schedule via the Bookings link
- [ ] Confirm all three tabs (Upcoming, Lesson Requests, Past) load correctly
  (Admin is also a club member and has personal bookings)
