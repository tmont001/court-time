# Phase 15D — QA & Regression Checklist

**Phase:** 15D (final checkpoint)
**Date:** \***\*\_\*\***
**Tester:** \***\*\_\*\***
**Vercel deployment URL:** \***\*\_\*\***
**Branch:** main
**Commits:** 15A `5ce8c21` · 15B `c1414a2` · 15C `109468a` + `8cda6bd`

**Status key:**

- `[ ]` Not tested
- `[x]` Pass
- `[!]` Fail — add notes below the item

---

## 1. Phase 15A — Mobile Shell Polish

### 1.1 Sticky header

Scroll the main content area on each page. The header must remain pinned at the top throughout the scroll.

- [x] `/calendar` — header visible above date pills and grid while scrolling
- [x] `/events` — header stays pinned when event list is long enough to scroll
- [x] `/my-schedule` — header stays pinned while scrolling past/upcoming items
- [x] `/profile` — header stays pinned while scrolling profile content
- [x] `/admin/members` — header stays pinned while scrolling member cards
- [x] `/admin/settings` — header stays pinned while scrolling settings sections
- [x] `/admin/audit-log` — header stays pinned while scrolling audit entries
- [x] `/help` — header stays pinned while scrolling help sections

### 1.2 BottomNav visibility and content clearance

- [x] BottomNav is always visible at the bottom of the screen on every page
- [x] Scrolling to the very bottom of any long page reveals the last content item above the BottomNav — no content is permanently hidden behind it
- [x] Active tab is highlighted (accent color + top border) and matches the current route
- [x] Tapping each tab navigates correctly: Calendar · Events · My Schedule · Profile

### 1.3 Safe-area behavior (iOS devices with home indicator)

Test on an iPhone X or later (or iOS Simulator with a notched device profile):

- [x] BottomNav tab icons and labels are fully visible above the home indicator; blank padding sits below them
- [x] No page content is obscured by the home indicator at the bottom of any scroll area
- [x] Header is not obscured by the status bar at the top

### 1.4 Horizontal overflow — no page-level horizontal scroll

Test at each viewport width. The page itself must never scroll horizontally. The calendar grid may scroll horizontally within its own container.

- [x] 390 px — no horizontal scrollbar or overflow on any page
- [x] 430 px — no horizontal scrollbar or overflow on any page
- [x] 500 px — no horizontal scrollbar or overflow on any page
- [x] 768 px — no horizontal scrollbar or overflow on any page

### 1.5 No gray gutters

At all tested viewport widths:

- [x] Content fills edge-to-edge; no gray strips visible on either side of the app
- [x] BottomNav spans full viewport width at every tested size
- [x] Bottom sheets (when open) span full viewport width

### 1.6 Dark-mode status bar and theme color

With system dark mode enabled:

- [x] Mobile status bar clock, battery, and signal icons are white/light-colored (readable against the dark `#111827` app background)
- [x] Switching back to light mode: status bar icons revert to dark/black
- [x] Verified on: \***\*\_\*\*** (device/browser)

### 1.7 Calendar usability with sticky layout

- [x] Calendar page loads with header sticky and BottomNav visible
- [x] Date pills strip scrolls horizontally; selecting a date updates the grid
- [x] Court filter chip row scrolls horizontally if many courts exist
- [x] Calendar grid scrolls vertically to reveal all time slots
- [x] Calendar grid fills the full viewport width (no narrow band in the center)

---

## 2. Phase 15B — Admin Members Sorting

Navigate to `/admin/members` as an admin user. Requires at least 2 members in the club.

### 2.1 Sort chip visibility

- [x] Four sort chips are visible above the member cards: **First Name · Last Name · Role · Status**
- [x] Sort chips are hidden when `members.length <= 1` (single-member club — note N/A if not testable)
- [x] Sort chips are hidden when members fail to load (error state — note N/A if not testable)
- [x] **First Name** chip is highlighted (accent color) on page load — this is the default sort

### 2.2 Sort correctness

Tap each chip and verify the card order:

- [x] **First Name ↑** (default) — A→Z by first name; blank/null names last
- [x] **First Name ↓** (tap active chip again) — Z→A; ↓ arrow visible on chip
- [x] **Last Name ↑** — A→Z by last name; blank/null last names last
- [x] **Last Name ↓** — Z→A
- [x] **Role ↑** — Admin cards first, then Pro, then Member
- [x] **Role ↓** — Member first, then Pro, then Admin
- [x] **Status ↑** — Active members before Inactive
- [x] **Status ↓** — Inactive members before Active
- [x] Switching from any active chip to a **different** chip always resets to ↑ (ascending); arrow updates correctly on the chip

### 2.3 Phase 14 controls preserved after sorting

- [x] Set sort to **Last Name**; change a member's role via their dropdown → role saves; page refreshes; sort resets to default (First Name ↑)
- [x] Set sort to **Role**; tap **Deactivate** on an active member → confirmation dialog shows the correct member's name (not another member's)
- [x] Confirm deactivation → member card dims (opacity-60); member appears in correct position under the current sort
- [x] Set sort to **Status**; tap **Reactivate** on an inactive member → member card brightens; sort position is correct
- [x] Set sort to **Role ↓**; identify the sole remaining active admin → "Last admin — cannot change." note appears on that card regardless of its position in the list; role dropdown and Deactivate button are both disabled on that card
- [x] Own row (your account): role dropdown is grayed out and Deactivate button is grayed out in every sort order

### 2.4 Pending Invites and InviteSheet

- [x] Pending Invites section appears below the member list regardless of current sort
- [x] Changing sort does not affect the order or content of Pending Invites
- [x] **Copy Link** copies the correct invite URL (paste and verify)
- [x] **Revoke** removes the invite after confirmation
- [x] **+ Invite** button opens InviteSheet with every sort active
- [x] Create a new invite via InviteSheet → new invite appears in Pending Invites after the sheet closes

---

## 3. Phase 15C — BottomSheet Migration

### 3.1 Component exists

- [x] `src/components/BottomSheet.tsx` is present in the codebase

### 3.2 ReservationDetailSheet

On `/calendar` as an admin, tap an existing reservation block:

- [x] Sheet slides up from the bottom with white/dark background and rounded top corners
- [x] Drag handle pill is visible at the top of the sheet
- [x] Sheet displays: court name, date, time range, "Booked by [name]"
- [x] **Tap backdrop** (dark overlay outside the sheet) → sheet closes; calendar returns
- [x] **Drag handle down ~50 px and release** → sheet snaps back to resting position
- [x] **Drag handle down ~100+ px and release** → sheet dismisses; calendar returns
- [x] **Tap Cancel Booking** → loading state "Cancelling…" → on success, sheet closes and the reservation block disappears from the grid
- [x] Error handling: if cancellation fails, an error message appears inside the sheet; the sheet stays open

For a maintenance block:

- [x] Notes and "Visible/Hidden from members" line appear correctly inside the sheet

### 3.3 NotificationSheet

Tap the bell icon in the header:

- [x] Sheet slides up with correct styling; "Notifications" title visible
- [x] Drag handle pill is visible at the top of the sheet
- [x] **Tap backdrop** → sheet closes
- [x] **Drag handle down ~50 px and release** → sheet snaps back
- [x] **Drag handle down ~100+ px and release** → sheet dismisses
- [x] Notification list renders: unread items have a blue dot; read items have an invisible spacer dot for alignment
- [x] Tapping an unread notification marks it as read (blue dot disappears — optimistic update)
- [x] **Mark all read** button appears when unread notifications exist; tapping it marks all read
- [x] Empty state ("You're all caught up.") appears when no notifications exist
- [x] Loading state appears briefly while fetching
- [x] **Dark mode:** "Notifications" title, notification body text, and "Mark all read" text are all readable against the dark panel background
- [x] Notification list scrolls inside the sheet without triggering drag-to-dismiss

### 3.4 Non-migrated sheets — regression

These sheets do **not** use BottomSheet and are intentionally not migrated in Phase 15C. Drag-to-dismiss is not expected on any of them.

**InviteSheet** (Admin Members → + Invite):

- [x] Opens correctly
- [x] Role selector and any form fields work
- [x] Submitting creates a new invite; it appears in Pending Invites after the sheet closes
- [x] Closing the sheet without submitting returns to Admin Members

**CreateEventSheet** (Calendar → + Event FAB, pro/admin only):

- [x] Opens with full form (title, date, time, court, capacity, event type)
- [x] Submitting creates the event; it appears on the calendar
- [x] Closing without saving does not create an event

**CreateMaintenanceSheet** (Calendar → + Block FAB, admin only):

- [x] Opens with form (court, date, time, notes, visibility)
- [x] Submitting creates the maintenance block; it appears on the calendar as a striped block
- [x] Closing without saving does not create a block

**EventDetailSheet** (Calendar → tap an event block):

- [x] Opens showing event title, type, time, court(s), participant count
- [x] Member: Join / Leave buttons work
- [x] Admin/pro: Cancel Event button works (with confirmation)

**EventRosterSheet** (accessible via EventDetailSheet if applicable):

- [x] Opens and shows participant list
- [x] Closes correctly

**Calendar slot action menu** (pro/admin → tap an empty slot):

- [x] Menu appears with correct options: Book Court · Create Event (admin also sees Maintenance Block)
- [x] Each option opens the correct next sheet or flow
- [x] Tapping backdrop/outside closes the menu

**Member booking sheet** (member role → tap an empty slot):

- [x] Booking sheet appears with court name, date, time, and duration selector (60 / 90 min)
- [x] Conflict detection works (90 min option disabled or warned if it would overlap an existing booking)
- [x] "Confirm Booking" creates the booking; slot shows as occupied in the grid

---

## 4. Calendar Regression

Full regression of calendar interactions.

### 4.1 Date navigation

- [x] Date pills strip shows today and surrounding dates
- [x] Today's date pill is visually distinguished (blue text)
- [x] Selected date pill is filled (accent background)
- [x] Tapping a date pill loads that day's reservations and events
- [x] Scrolling/swiping the date strip does not trigger page navigation

### 4.2 Court filter

- [x] "All" chip selects all courts
- [x] Individual court chips toggle courts on/off
- [x] At least one court remains selected at all times (last active court cannot be deselected)
- [x] Grid updates immediately when courts are toggled

### 4.3 Booking — member role

Log in as a member:

- [x] Tapping an empty slot opens the booking sheet directly (no action menu)
- [x] 60 min and 90 min duration options are both available
- [x] Conflict check: if 90 min would overlap an existing booking, a warning appears and Confirm is disabled
- [x] "Confirm Booking" succeeds; the slot is now shown as occupied in the grid
- [x] Occupied slot cannot be re-tapped by the same user

### 4.4 Slot action menu — pro/admin role

Log in as pro or admin:

- [x] Tapping an empty slot shows the action menu (not the booking sheet directly)
- [x] "Book Court" option present for both pro and admin
- [x] "Create Event" option present for both pro and admin
- [x] "Maintenance Block" option present for admin only (not for pro)
- [x] Each option opens the correct sheet

### 4.5 Blocks and events on the grid

- [x] Tapping a reservation block opens ReservationDetailSheet
- [x] Tapping an event block opens EventDetailSheet
- [x] Tapping a maintenance block opens ReservationDetailSheet (with maintenance details)

### 4.6 Operating hours

- [x] Slots outside the configured open/close time are not shown or are disabled
- [x] The grid only displays the configured operating hours window for the selected day
- [x] Changing the selected date to a day with different hours updates the grid start/end correctly

### 4.7 Closed-day behavior

On a day configured as closed in Admin Settings → Operating Hours:

- [x] Amber "Club closed" banner appears above the grid
- [x] All slots in the grid are disabled (cannot be tapped)
- [x] No booking or action menu appears on slot tap

---

## 5. Admin Settings Regression

Navigate to `/admin/settings` as an admin.

### 5.1 Operating Hours editor

- [x] All 7 days are shown with their current open/close times and Closed toggle
- [x] Editing a day's open time and saving → change reflected immediately in the editor
- [x] Editing a day's close time and saving → change reflected
- [x] Toggling a day to Closed and saving → day shows as Closed
- [x] If a future reservation would be affected by the hours change, a conflict warning dialog appears before saving
- [x] Operating hours changes are reflected in the calendar on the next page load (slots outside new hours are not bookable)

### 5.2 Booking Rules

- [x] Booking Rules form loads with current values
- [x] Editing a rule value and saving → saved successfully (no error toast or error state)

### 5.3 Club Branding / Theme

- [x] Club name field saves correctly
- [x] Theme picker cycles through all available themes; selected theme applies to the app accent color immediately
- [x] Club logo upload section is present

### 5.4 Court Management not duplicated

- [x] Court Management section does **not** appear on `/admin/settings` (removed in Phase 14E)
- [x] Courts remain accessible from `/profile` (admin section) or `/admin/courts`

---

## 6. Admin Members Regression (Phase 14)

Navigate to `/admin/members` as an admin.

### 6.1 Role management

- [x] Role dropdown is present on each member card (except own row and last-admin row)
- [x] Changing a member's role via the dropdown → role saves with no error
- [x] Role change is reflected immediately on the card after save

### 6.2 Status management

- [x] Deactivate button is present on each active member card (except own row and last-admin row)
- [x] Tapping Deactivate → confirmation dialog shows correct member name → confirming deactivates the member; card dims
- [x] Inactive members remain visible in the list (not hidden)
- [x] Reactivate button is present on inactive member cards; tapping it reactivates the member; card brightens

### 6.3 Last-admin and self-protection

- [x] When only one active admin exists: that admin's role dropdown and Deactivate button are both disabled; "Last admin — cannot change." note appears on their card
- [x] Your own row: role dropdown and Deactivate button are both disabled regardless of your role

### 6.4 Audit logging

- [x] After changing a member's role, a new entry appears in `/admin/audit-log` recording the change
- [x] After deactivating or reactivating a member, a new entry appears in `/admin/audit-log`

---

## 7. Build and Deploy

- [x] `pnpm tsc --noEmit` — exits with no output (zero TypeScript errors)
- [x] `pnpm build` — exits with "✓ Compiled successfully" and all routes listed; zero warnings
- [x] Push to `main` → Vercel deployment reaches **Ready** status
- [x] Vercel deployment URL loads the app correctly (sign-in page or calendar if already authenticated)

---

## 8. Known Notes / Deferred Items

- **Drag-to-dismiss** is implemented only on the two migrated sheets: **NotificationSheet** and **ReservationDetailSheet**. It is not expected on InviteSheet, CreateEventSheet, CreateMaintenanceSheet, EventDetailSheet, EventRosterSheet, the slot action menu, or the member booking sheet.
- **InviteSheet migration** to BottomSheet is intentionally deferred — candidate for a later polish checkpoint once BottomSheet is confirmed stable on real devices.
- **CreateEventSheet, CreateMaintenanceSheet, EventDetailSheet, EventRosterSheet, Calendar slot action menu, and member booking sheet** are intentionally not migrated in Phase 15C.
- **Notifications & Communications** — deferred to Phase 16+. No notification changes in Phase 15 beyond the NotificationSheet styling migration.
- **Event/guest registration** — deferred.
- **Public embeds** — deferred.
- **Operator setup UI, multi-club switching, self-serve club signup** — deferred.

---

## Phase 15 Summary

| Checkpoint                  | Status         | Commits               |
| --------------------------- | -------------- | --------------------- |
| 15A Mobile Shell Polish     | ✅ Complete    | `5ce8c21`             |
| 15B Admin Members Sorting   | ✅ Complete    | `c1414a2`             |
| 15C BottomSheet + Migration | ✅ Complete    | `109468a` · `8cda6bd` |
| 15D QA / Regression         | ⏳ In progress | —                     |
