# QA Checklist — Phase 22C: Performance and Navigation

**Status: Implementation complete — manual QA pending**

## What changed

Per-request React.cache() memoization for auth.getUser() and profile queries.
All authenticated layouts and pages now share a single auth validation and
a single profile query per request rather than issuing duplicates.

my-schedule data fetches consolidated: club + settings + reservations +
event_participants now execute in one Promise.all instead of two sequential batches.

Admin-specific loading.tsx added for admin route transitions.

No database changes. No migrations. No UI redesign.

---

## 1. Member navigation

- [ ] Sign in as a member and navigate Calendar → Events → Bookings → Account
- [ ] Each page loads correctly with data (no blank pages, no auth errors)
- [ ] Loading skeleton visible during each transition
- [ ] Navigating back (browser back button) works correctly
- [ ] Navigating forward (browser forward) works correctly
- [ ] Repeat navigation (Calendar → Events → Calendar → Events) loads data correctly each time

## 2. Admin navigation

- [ ] Sign in as an admin and navigate Account → Overview → Members → Courts → Settings → Audit Log
- [ ] Each admin page loads with correct data (member list, court list, settings, audit rows)
- [ ] Admin loading skeleton visible during transitions to/from admin pages
- [ ] Returning from admin pages to Account (← Back to Account link) works
- [ ] Navigate Calendar → Account → Overview → Calendar — no stale role or club data

## 3. Pro navigation

- [ ] Sign in as a pro and navigate Calendar → Events → Account → Overview
- [ ] Pro cannot access /admin/members, /admin/courts, /admin/settings, /admin/audit-log
  - Attempting any of those should redirect to /calendar
- [ ] Pro CAN access /admin/overview and /events?tab=manage

## 4. Role and club isolation

- [ ] Member cannot navigate to /admin/* (redirected to /calendar)
- [ ] Admin sees setup checklist and system status on /admin/overview
- [ ] Pro does NOT see setup checklist or system status on /admin/overview
- [ ] Signed-out visitor navigating to /calendar is redirected to /sign-in

## 5. Loading feedback

- [ ] Navigating to /calendar shows calendar-specific skeleton (date strip + court grid)
- [ ] Navigating to /events shows events-specific skeleton (event card rows)
- [ ] Navigating to /my-schedule shows schedule-specific skeleton (date header + cards)
- [ ] Navigating to any /admin/* page shows admin loading skeleton (header + card rows)
- [ ] Navigating to /profile and sub-pages shows generic (app) loading skeleton
- [ ] No blank white flash before skeleton appears
- [ ] No layout shift (sidebar / bottom nav remain in place during loading)

## 6. Mobile bottom navigation

- [ ] Tapping Calendar, Events, Bookings, Account tabs navigates correctly
- [ ] Active tab highlighted correctly on each page
- [ ] Bottom nav stays visible during loading
- [ ] Safe area inset respected (no content hidden behind home indicator on iOS)

## 7. Desktop side navigation

- [ ] Calendar, Events, Bookings, Account links in sidebar work correctly
- [ ] Active link highlighted (bg-gray-100 + text-accent) on each page
- [ ] Sidebar remains visible during loading
- [ ] Admin sub-pages (/admin/overview etc.) do not highlight any primary nav item

## 8. My Bookings (my-schedule) data

- [ ] Upcoming court reservations displayed correctly
- [ ] Upcoming event signups displayed correctly
- [ ] Waitlisted and offered events show correct status badges
- [ ] Past events section visible and collapsible
- [ ] Cancel button present for cancellable reservations
- [ ] Cancel button absent when within cancellation window (outside grace period)
- [ ] Court names resolve correctly next to reservations and events

## 9. Invitation and authentication regressions

- [ ] Visiting /join/<code> while signed out → sign-up or sign-in → invite auto-accepted
- [ ] Signing in via /sign-in with a redirect param to /join/<code> → invite auto-accepted
- [ ] Visiting /join/<code> while signed in with no club → invite accepted, redirected to /calendar or /welcome
- [ ] /pending-invite shows "Sign out and return to sign in" only (no code entry form)
- [ ] AppLayout invite-cookie redirect: visiting /join/<code>, then navigating to /calendar → redirect to /join/<code> if not yet accepted
- [ ] After accepting an invite: /calendar loads with correct club theme

## 10. Public marketing regression

- [ ] Logged-out user visits / → sees landing page (not redirect to sign-in)
- [ ] Logged-in user visits / → redirected to /calendar
- [ ] /pricing, /contact, /terms, /privacy all load without authentication
- [ ] Marketing nav and footer do not appear on authenticated app pages
- [ ] App nav (SideNav, BottomNav) does not appear on marketing pages

## 11. Repeat navigation and data freshness

- [ ] After booking a court, navigating to /my-schedule shows the new booking
- [ ] After joining an event, navigating to /events shows the updated status
- [ ] After an admin adds a member, navigating away and back to /admin/members shows the new member
- [ ] After an admin changes club settings, navigating away and back to /admin/settings shows the saved values

## 12. Theme and club data

- [ ] Club theme (from clubs.theme_key) applied correctly on first load
- [ ] Theme change in admin settings takes effect after refresh / navigation
- [ ] Dark mode works on all authenticated pages

## 13. TypeScript and build

- [ ] pnpm tsc --noEmit: 0 errors
- [ ] pnpm build: exit 0, no errors
- [ ] All marketing static routes present in build output: /pricing, /contact, /terms, /privacy
- [ ] All app dynamic routes present: /calendar, /events, /my-schedule, /profile, /admin/*
