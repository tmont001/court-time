# Phase 16E — QA Checklist

Covers checkpoints 16A–16D. Mark each item ✅ Pass, ❌ Fail (add notes), or ⚠️ Partial.

---

## Setup

- [ ] `pnpm tsc --noEmit` passes with no errors
- [ ] `pnpm build` passes with no errors or warnings
- [ ] Migrations applied in Supabase SQL Editor:
  - 0039 — expand notification kinds
  - 0040 — notify_reservation_cancelled_by_member RPC
  - 0041 — send_announcement RPC
- [ ] `alter publication supabase_realtime add table public.notifications` applied
- [ ] `notifications` appears in `pg_publication_tables` for `supabase_realtime`
- [ ] Twilio credentials NOT configured (pilot state — all SMS tests use no-Twilio path)

---

## 16A — SMS Dispatch: Booking Confirmation

### In-app notification
- [ ] Member books a court on the calendar → `reservation_confirmed` notification appears in the bell sheet
- [ ] Notification body includes court name and formatted time (e.g. "Court A booked for May 26 at 10:00 AM")

### SMS dispatch (no Twilio)
- [ ] After booking: `notification_deliveries` row exists for the notification
- [ ] Member with `sms_opt_in = false` → `status = opted_out`
- [ ] Member with `sms_opt_in = true` and phone set → `status = failed`, `error = 'SMS is not configured.'`, `provider = twilio`
- [ ] Member with `sms_opt_in = true` and no phone → `status = no_phone`

### Booking UX unchanged
- [ ] Booking confirmation dialog closes on success
- [ ] Calendar refreshes after booking
- [ ] Booking errors (outside window, overlap, etc.) still display correctly
- [ ] No error shown to user when SMS dispatch fails

---

## 16A — SMS Dispatch: Event Join Confirmation

### In-app notification
- [ ] Member joins an event with open capacity via **EventDetailSheet** → `event_joined` notification in bell sheet
- [ ] Member joins an event with open capacity via **Events page** → `event_joined` notification in bell sheet
- [ ] Notification body includes event title (e.g. "You've joined "Tuesday Clinic".")

### SMS dispatch (no Twilio)
- [ ] After joining (confirmed): `notification_deliveries` row exists with expected status
- [ ] Member with `sms_opt_in = false` → `status = opted_out`
- [ ] Member with phone + no Twilio → `status = failed`
- [ ] Member with no phone → `status = no_phone`

### Waitlist join — no SMS
- [ ] Member joins a full event → placed on waitlist
- [ ] No `event_joined` notification created (in-app)
- [ ] No `notification_deliveries` row created for waitlisted join

### Event join UX unchanged
- [ ] EventDetailSheet closes on successful join
- [ ] Events page reflects joined/waitlisted status after action
- [ ] Join errors (already joined, event not found) still display correctly

---

## 16B — Member Self-Cancellation Notification

### In-app notification
- [ ] Member cancels own reservation from My Schedule → `reservation_cancelled_by_member` notification in bell sheet
- [ ] Notification body includes formatted date/time of the cancelled reservation
- [ ] Notification metadata includes `reservation_id`

### SMS dispatch (no Twilio)
- [ ] After self-cancel: `notification_deliveries` row exists with expected status
- [ ] Member with `sms_opt_in = false` → `status = opted_out`
- [ ] Member with phone + no Twilio → `status = failed`
- [ ] Member with no phone → `status = no_phone`

### Cancellation rules unchanged
- [ ] Cancel inside window and outside grace period → blocked (no notification created)
- [ ] Cancel within grace period → succeeds, notification created
- [ ] Cancel outside window → succeeds, notification created
- [ ] Admin self-cancel is exempt from window (admin can always cancel)
- [ ] No error shown to user when notification/SMS fails

### Admin cancel unchanged (regression)
- [ ] Admin cancels member's reservation → `reservation_cancelled_by_admin` notification for the member (not `by_member`)
- [ ] SMS dispatch for admin cancel still runs correctly (opted_out/no_phone/failed as appropriate)

---

## 16C — Admin Announcements

### UI / form
- [ ] Admin sees "Member Announcements" section on `/admin/settings`
- [ ] Subject and message fields present with character counters
- [ ] Subject counter turns red above 100 chars; Send button disabled
- [ ] Message counter turns red above 500 chars; Send button disabled
- [ ] Send button disabled when either field is empty
- [ ] Clicking "Send Announcement" shows confirmation banner: "Send this announcement to all active members?"
- [ ] Clicking "Cancel" on confirmation dismisses it without sending
- [ ] Clicking "Yes, send it" sends the announcement

### Delivery
- [ ] All active members of the club receive an `announcement` notification
- [ ] Sending admin is NOT in the recipient list
- [ ] Inactive members do NOT receive the announcement
- [ ] Success message shows correct recipient count (e.g. "Announcement sent to 3 members.")

### NotificationSheet rendering
- [ ] Announcement notification shows amber unread dot (not blue)
- [ ] Announcement notification shows `📢 {title}` header above body text
- [ ] Other notification kinds (reservation_confirmed, event_joined, etc.) still show blue dot — no regression
- [ ] Mark-as-read and mark-all-read work for announcement notifications

### Security
- [ ] `send_announcement` RPC raises `insufficient_role` for non-admin callers
- [ ] Announcement notifications scoped to correct club only
- [ ] `audit_log` row written with action `send_announcement`, title, and recipient_count

### SQL verify

```sql
-- Announcement notifications
select kind, body, metadata, created_at
from notifications
where kind = 'announcement'
order by created_at desc
limit 5;

-- Audit log
select action, metadata, created_at
from audit_log
where action = 'send_announcement'
order by created_at desc
limit 3;
```

---

## 16D — Real-Time Notification Bell

### Subscription
- [ ] After page load, Supabase Realtime WebSocket connection is open (DevTools → Network → WS)
- [ ] No console errors related to Realtime on load

### Live update
- [ ] Admin sends announcement in a separate browser session → member bell count increments without page refresh
- [ ] Bell count reflects true unread count (not an optimistic increment)

### Read/unread lifecycle
- [ ] Opening the sheet and marking notifications read decreases/clears the badge
- [ ] Marking all read clears the badge to 0

### Cleanup
- [ ] Sign out → sign back in → only one WebSocket connection open (no duplicates)
- [ ] Navigating between pages does not accumulate stale channels

### Unauthenticated state
- [ ] Signed-out state: bell renders with count 0, no Realtime errors in console

---

## Regression — Phase 8 SMS flows

- [ ] Admin cancels reservation → owner receives `reservation_cancelled_by_admin` in-app notification
- [ ] Admin cancels reservation → SMS dispatch runs (opted_out/no_phone/failed as appropriate)
- [ ] Admin cancels event → all confirmed + waitlisted participants receive `event_cancelled` notification
- [ ] Admin cancels event → SMS dispatch runs for each participant
- [ ] Member leaves event (waitlist promotion) → promoted member receives `waitlist_promoted` notification
- [ ] Member leaves event (waitlist promotion) → SMS dispatch runs for promoted member

---

## Regression — Phase 14 role/status protections

- [ ] Inactive member cannot book a court
- [ ] Inactive member cannot join an event
- [ ] Non-admin cannot access `/admin/settings`
- [ ] Non-admin cannot call `send_announcement` RPC directly

---

## Regression — Phase 15 mobile layout

- [ ] NotificationSheet opens as BottomSheet on mobile (drag handle visible)
- [ ] Drag-to-dismiss works on NotificationSheet
- [ ] Bell badge renders correctly on mobile (no overflow or clipping)
- [ ] Admin settings page (with new Announcements section) scrolls correctly on mobile

---

## SQL reference queries

```sql
-- Recent notifications (all kinds)
select id, kind, body, is_read, metadata, created_at
from notifications
order by created_at desc
limit 10;

-- Recent delivery records
select nd.created_at, nd.channel, nd.status, nd.provider, nd.error, n.kind
from notification_deliveries nd
join notifications n on n.id = nd.notification_id
order by nd.created_at desc
limit 10;

-- Confirm notifications in realtime publication
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename = 'notifications';
```

---

## Results

| Checkpoint | Status | Notes |
|---|---|---|
| 16A Booking SMS | | |
| 16A Event Join SMS | | |
| 16B Self-Cancel Notification | | |
| 16C Admin Announcements | | |
| 16D Real-Time Bell | | |
| Phase 8 SMS Regression | | |
| Phase 14 Role Regression | | |
| Phase 15 Mobile Regression | | |
