# QA Checklist — Phase 18D

# Waitlist Offer Confirmation (18A–18C)

# Run this checklist against the live Supabase environment before marking Phase 18 complete.

---

## Prerequisites

- At least two active member accounts (Member A, Member B) in the same club.
- At least one scheduled future event with capacity ≥ 1.
- Admin account available for roster and settings checks.
- `pnpm dev` running locally (or test against staging/production).
- Supabase SQL Editor available for direct DB inspection.

---

## 1. Schema verification (18A)

Run in Supabase SQL Editor:

```sql
-- 1a. event_participants.status allows 'offered'
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname = 'event_participants_status_check';
-- Expect: includes 'offered'

-- 1b. offer_expires_at column exists
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'event_participants'
  and column_name = 'offer_expires_at';
-- Expect: timestamptz, nullable

-- 1c. waitlist_offer_window_hours column exists with default 2
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'club_settings'
  and column_name = 'waitlist_offer_window_hours';
-- Expect: integer, default 2

-- 1d. notifications.kind allows 'waitlist_offer'
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conname = 'notifications_kind_check';
-- Expect: includes 'waitlist_offer'
```

**Pass criteria:** All four queries return expected results.

---

## 2. RPC presence (18A)

```sql
select proname from pg_proc
where proname in (
  'advance_waitlist_offer',
  'expire_stale_offers_for_event',
  'accept_waitlist_offer',
  'decline_waitlist_offer'
)
order by proname;
-- Expect: all four rows returned

-- update_club_settings 4-arg overload exists
select proname, pronargs from pg_proc
where proname = 'update_club_settings';
-- Expect: one row with pronargs = 4

-- get_event_roster returns offer_expires_at
select attname from pg_attribute
join pg_class on pg_class.oid = pg_attribute.attrelid
where pg_class.relname = 'get_event_roster'
  and attnum > 0;
-- Expect: offer_expires_at listed among columns
```

**Pass criteria:** All functions present; update_club_settings has 4 args; get_event_roster includes offer_expires_at.

---

## 3. Waitlist offer window admin setting (18C)

- [x] Log in as admin → `/admin/settings` → Booking Rules section.
- [x] **Waitlist offer window (hours)** field is visible with current value (default 2).
- [x] Change to `1` → Save → success message appears.
- [x] Reload page → field shows `1`.
- [x] Change to `0` → Save → error: "Waitlist offer window must be between 1 and 72 hours."
- [x] Change to `73` → Save → same error.
- [x] Change back to `2` → Save → succeeds.
- [x] Other Booking Rules fields (booking window, cancellation window, grace period) save and persist correctly alongside offer window changes.

---

## 4. Core offer flow — member leaves, next waitlisted member receives offer

**Setup:** Event at full capacity. Member B on waitlist. Offer window = 2 hours (default).

Steps:

- [x] Member A (confirmed) leaves the event from EventDetailSheet or Events page.
- [x] Check `event_participants` in DB:
  ```sql
  select profile_id, status, offer_expires_at
  from event_participants
  where event_id = '<event-id>'
    and status in ('offered', 'waitlisted', 'confirmed');
  ```
  **Expect:** Member B row has `status = 'offered'` and `offer_expires_at ≈ now() + 2h`.
- [x] Check `notifications` in DB:
  ```sql
  select kind, body, metadata
  from notifications
  where user_id = '<member-b-id>'
    and kind = 'waitlist_offer'
  order by created_at desc limit 1;
  ```
  **Expect:** Row present with body mentioning event title and deadline; metadata contains `event_id` and `offer_expires_at`.

---

## 5. Accept spot — EventDetailSheet (18B)

**Setup:** Member B has `status = 'offered'` with a future `offer_expires_at`.

- [x] Log in as Member B → Calendar → tap the event.
- [x] **Expect:** Sheet shows amber "Spot offered" banner.
- [x] **Expect:** "Accept by [time]" deadline shown (matches `offer_expires_at` in club timezone).
- [x] **Expect:** Two buttons: **Pass** and **Accept Spot**. No Join/Leave/Waitlist button.
- [x] **Expect:** Capacity line shows `confirmedCount + offeredCount` of capacity (Member B's offered spot counts).
- [x] Click **Accept Spot** → loading state on button ("Accepting…"), other button disabled.
- [x] After success: sheet closes, event refreshes.
- [x] Check DB:
  ```sql
  select status, offer_expires_at from event_participants
  where event_id = '<event-id>' and profile_id = '<member-b-id>';
  ```
  **Expect:** `status = 'confirmed'`, `offer_expires_at = null`.
- [x] Check `notifications`:
  ```sql
  select kind, body from notifications
  where user_id = '<member-b-id>' and kind = 'waitlist_promoted'
  order by created_at desc limit 1;
  ```
  **Expect:** Row present ("You've accepted and are confirmed for…").
- [x] Reopen EventDetailSheet as Member B → shows **Leave Event** button (normal confirmed state).

---

## 6. Pass — EventDetailSheet (18B)

**Setup:** Member B has `status = 'offered'`. Member C is next on waitlist (if available).

- [x] Log in as Member B → Calendar → tap event → see offer UI.
- [x] Click **Pass** → loading state ("Passing…"), other button disabled.
- [x] After success: sheet closes.
- [x] Check DB — Member B: `status = 'cancelled'`, `offer_expires_at = null`.
- [x] If Member C was on waitlist: check Member C now has `status = 'offered'` (queue advanced).
- [x] If no one else on waitlist: spot remains open.
- [x] Reopen event as Member B → shows **Join Event** or **Join Waitlist** (can rejoin if desired).

---

## 7. Accept spot — Events page (18B)

**Setup:** Member B has `status = 'offered'`.

- [x] Log in as Member B → `/events`.
- [x] **Expect:** Event card shows **Spot offered** badge (amber).
- [x] **Expect:** "Accept by [time]" text below event title/time.
- [x] **Expect:** **Pass** and **Accept** links on the right of the capacity row.
- [x] **Expect:** Capacity row shows `confirmedCount + offeredCount / capacity`.
- [x] Click **Accept** → page reloads.
- [x] **Expect:** Event card now shows **Joined** badge; no Pass/Accept links.

---

## 8. Pass — Events page (18B)

**Setup:** Member B has `status = 'offered'`.

- [x] Log in as Member B → `/events`.
- [x] Click **Pass** → page reloads.
- [x] **Expect:** Member B no longer shows Spot offered badge; shows Join Event/Join Waitlist option.

---

## 9. Expired offer — client-side (18B)

**Setup:** Manually set `offer_expires_at` to a past timestamp for Member B's offered row:

```sql
update event_participants
set offer_expires_at = now() - interval '1 minute'
where event_id = '<event-id>' and profile_id = '<member-b-id>';
```

EventDetailSheet:

- [x] Log in as Member B → Calendar → tap event.
- [x] **Expect:** "This offer has expired. Rejoin the waitlist if you're still interested." message in amber box.
- [x] **Expect:** Accept Spot / Pass buttons are NOT shown.
- [x] **Expect:** **Rejoin Waitlist** or **Rejoin Event** button shown.
- [x] Click **Rejoin** → Member B placed on waitlist (or confirmed if slot available).

Events page:

- [x] Log in as Member B → `/events`.
- [x] **Expect:** **Offer expired** badge (gray) shown instead of Spot offered.
- [x] **Expect:** No Accept/Pass links; **Rejoin** link shown instead.

---

## 10. Capacity accounting (18B)

**Scenario:** Event with capacity = 2. Member A confirmed. Member B offered. Member C waitlisted.

- [x] EventDetailSheet (opened by any user): capacity line shows `2 of 2 spots filled · 1 on waitlist`.
- [x] Events page: capacity row shows `2 / 2 joined · 1 waitlisted`.
- [x] EventRosterSheet: roster count in "View Roster (N)" includes offered row.

---

## 11. Admin roster — Offered section (18C)

**Setup:** At least one member with `status = 'offered'`.

- [x] Log in as admin → Calendar → tap event → **View Roster**.
- [x] **Expect:** **Offered** section appears between Confirmed and Waitlist.
- [x] **Expect:** Section heading in amber ("Offered (N)").
- [x] **Expect:** Offered member's name shown.
- [x] **Expect:** "Offer expires [time]" shown in amber (if offer is active).
- [x] **Expect:** No Attended / No-show / Clear attendance buttons on offered rows.
- [x] **Expect:** No position number (#N) on offered rows.
- [x] **Expect:** Confirmed section still shows attendance controls.
- [x] **Expect:** Waitlist section still shows position numbers.

- [x] Log in as admin → `/events` → Roster button on an event card → same Offered section visible.

---

## 12. Admin roster — expired offered row (18C)

**Setup:** Set `offer_expires_at` to past for an offered row (see step 9 SQL).

- [x] Open EventRosterSheet as admin.
- [x] **Expect:** Row appears in Offered section with "Expired [time]" in gray/muted text (not amber).

---

## 13. leave_event creates offer, not direct promotion

- [x] Member A (confirmed) leaves a full event with Member B on waitlist.
- [x] Check `notifications` for Member B:
  ```sql
  select kind from notifications
  where user_id = '<member-b-id>'
  order by created_at desc limit 3;
  ```
  **Expect:** Most recent notification is `waitlist_offer` (NOT `waitlist_promoted`).
- [x] Member B is NOT immediately confirmed — status is `offered`.

---

## 14. join_event with offered row in capacity count

**Scenario:** Event capacity = 1. Member A confirmed. No waitlist. Member B has an offered row (from a leave scenario where advance ran). Member C tries to join.

- [x] Member C → tap event → EventDetailSheet shows `1 of 1 spots filled` (offered counts).
- [x] Button shows **Join Waitlist** (not **Join Event**), because confirmed + offered = capacity.
- [x] Member C clicks **Join Waitlist** → placed on waitlist, not confirmed.

---

## 15. cancel_event clears offered rows and notifies (18A)

**Setup:** Event with 1 confirmed (Member A), 1 offered (Member B), 1 waitlisted (Member C). Admin cancels.

- [x] Admin → EventDetailSheet → Cancel Event → confirm.
- [x] Check DB:
  ```sql
  select profile_id, status, offer_expires_at
  from event_participants where event_id = '<event-id>';
  ```
  **Expect:** Member B: `status = 'cancelled'`, `offer_expires_at = null`.
- [x] Check notifications for Member B:
  ```sql
  select kind from notifications
  where user_id = '<member-b-id>' and kind = 'event_cancelled'
  order by created_at desc limit 1;
  ```
  **Expect:** `event_cancelled` notification created (offered participants are notified).

---

## 16. Lazy expiry — join_event clears stale offered rows

**Setup:** Member B has an expired offered row (`offer_expires_at` in the past). Member C tries to join.

- [x] Member C → tap event → Join Event / Join Waitlist.
- [x] After join: check Member B's row → `status = 'cancelled'` (expired row cleaned up by join_event's expire call).
- [x] Check audit_log:
  ```sql
  select action, metadata from audit_log
  where action = 'waitlist_offer_expired'
  order by created_at desc limit 1;
  ```
  **Expect:** Entry present for Member B's profile_id.

---

## 17. Existing flows unaffected (regression)

- [x] Non-full event: member joins → confirmed immediately, **Join Event** button shown.
- [x] Full event: member joins → waitlisted, **Leave Waitlist** button shown with position.
- [x] Member leaves waitlist → removed, others retain position numbers.
- [x] Host sees **You're the Host** (disabled) in EventDetailSheet.
- [x] Admin sees Cancel Event option; cancellation completes without error.
- [x] Booking Rules fields (booking window, cancellation window, grace period) still save correctly.
- [x] Operating Hours and Special Closures unaffected.

---

## Sign-off

| Checkpoint                                         | Status |
| -------------------------------------------------- | ------ |
| 1. Schema columns and constraints                  | ☐      |
| 2. RPC presence                                    | ☐      |
| 3. Offer window admin setting                      | ☐      |
| 4. Leave event → offer created                     | ☐      |
| 5. Accept — EventDetailSheet                       | ☐      |
| 6. Pass — EventDetailSheet                         | ☐      |
| 7. Accept — Events page                            | ☐      |
| 8. Pass — Events page                              | ☐      |
| 9. Expired offer client-side                       | ☐      |
| 10. Capacity accounting                            | ☐      |
| 11. Admin roster offered section                   | ☐      |
| 12. Admin roster expired offered row               | ☐      |
| 13. leave_event creates offer (not direct promote) | ☐      |
| 14. join_event respects offered capacity           | ☐      |
| 15. cancel_event clears offered rows               | ☐      |
| 16. Lazy expiry on join_event                      | ☐      |
| 17. Regression — existing flows                    | ☐      |
