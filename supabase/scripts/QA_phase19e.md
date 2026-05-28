# QA Checklist — Phase 19E

## Admin Event & Participant Management (19A–19D)

Run this checklist against the live Supabase environment before marking Phase 19 complete.

---

## Prerequisites

- At least two active member accounts (Member A, Member B) in the same club.
- At least one admin account and one pro account.
- At least one scheduled future event with capacity ≥ 2.
- `pnpm dev` running locally (or test against staging/production).
- Supabase SQL Editor available for direct DB inspection.

---

## 1. Schema verification (19A)

Run in Supabase SQL Editor:

```sql
-- 1a. event_guests table exists with expected columns
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'event_guests'
order by ordinal_position;
-- Expect: id (uuid), event_id (uuid), display_name (text), added_by (uuid), created_at (timestamptz)

-- 1b. event_guests primary key and FK constraints
select conname, contype, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'event_guests'::regclass
order by conname;
-- Expect: PK on id; FK event_id → events(id) ON DELETE CASCADE; FK added_by → profiles(id)

-- 1c. display_name check constraint (no blank names)
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'event_guests'::regclass
  and contype = 'c';
-- Expect: check(char_length(trim(display_name)) >= 1)

-- 1d. RLS is enabled on event_guests
select relname, relrowsecurity
from pg_class
where relname = 'event_guests';
-- Expect: relrowsecurity = true

-- 1e. RLS SELECT policy exists for club members
select policyname, cmd, qual
from pg_policies
where tablename = 'event_guests';
-- Expect: event_guests_select_club_members, cmd = SELECT
-- No INSERT/UPDATE/DELETE policies (writes only via RPCs)
```

**Pass criteria:** All five queries return expected results.

---

## 2. get_event_roster returns guests (19A)

```sql
-- 2a. get_event_roster return columns include role and sort_group
select attname, atttypid::regtype
from pg_attribute
join pg_class on pg_class.oid = pg_attribute.attrelid
where pg_class.relname = 'get_event_roster'
  and attnum > 0
order by attnum;
-- Expect columns: profile_id, display_name, role, status, attendance_status,
--                 offer_expires_at, waitlist_position

-- 2b. After adding a guest to an event, verify roster result
-- (replace <event-id> with a real event that has a guest)
select profile_id, display_name, role, status, waitlist_position
from get_event_roster('<event-id>')
order by role;
-- Expect: guest row has role='guest', status='confirmed', waitlist_position=null
-- guest's profile_id = event_guests.id (a UUID, not a profiles FK)
```

**Pass criteria:** Columns present; guest rows appear with role='guest' and correct profile_id.

---

## 3. Capacity formula includes guests (19A)

```sql
-- 3a. join_event and advance_waitlist_offer capacity count includes event_guests
-- Inspect the function body for the capacity subquery
select prosrc from pg_proc where proname = 'join_event';
-- Expect: subquery summing event_participants (confirmed+offered) + event_guests count

select prosrc from pg_proc where proname = 'advance_waitlist_offer';
-- Expect: same combined capacity count
```

**Pass criteria:** Both function bodies reference `event_guests` in the capacity calculation.

---

## 4. Admin participant RPCs present (19B)

```sql
select proname from pg_proc
where proname in (
  'admin_add_member',
  'admin_remove_participant',
  'admin_force_confirm',
  'admin_offer_spot',
  'admin_expire_offer',
  'admin_add_guest',
  'admin_remove_guest'
)
order by proname;
-- Expect: all 7 rows returned
```

**Pass criteria:** All 7 RPCs present.

---

## 5. Admin RPCs are SECURITY DEFINER (19B)

```sql
select proname, prosecdef
from pg_proc
where proname in (
  'admin_add_member', 'admin_remove_participant', 'admin_force_confirm',
  'admin_offer_spot', 'admin_expire_offer', 'admin_add_guest', 'admin_remove_guest'
)
order by proname;
-- Expect: prosecdef = true for all 7
```

**Pass criteria:** All 7 have `prosecdef = true`.

---

## 6. Add Guest — basic flow (19B / 19C)

**Setup:** Scheduled event with at least one open slot.

- [ ] Log in as admin → Calendar → open event → View Roster.
- [ ] **Expect:** `+ Add Guest` button visible at top of roster.
- [ ] Click `+ Add Guest` → inline input appears with placeholder "Guest name".
- [ ] Type a name (e.g., "Alex Smith") → click Add.
- [ ] **Expect:** Roster refreshes; Guests section appears at the bottom with "Alex Smith".
- [ ] Check DB:
  ```sql
  select id, display_name, added_by, created_at
  from event_guests
  where event_id = '<event-id>';
  -- Expect: one row with display_name = 'Alex Smith'
  ```
- [ ] Check audit_log:
  ```sql
  select action, metadata from audit_log
  where action = 'admin_add_guest'
  order by created_at desc limit 1;
  -- Expect: row present with event_id in metadata
  ```

---

## 7. Add Guest — blank name rejected (19C)

- [ ] Open Add Guest inline form.
- [ ] Leave input empty → click Add.
- [ ] **Expect:** Error message "Enter a guest name." shown inline. No guest added.
- [ ] Type only spaces → click Add.
- [ ] **Expect:** Same error (backend check constraint + RPC guard).

---

## 8. Add Guest — Enter key submits (19C)

- [ ] Open Add Guest form → type name → press Enter.
- [ ] **Expect:** Guest added (same as clicking Add).

---

## 9. Remove Guest (19B / 19C)

**Setup:** Event with at least one guest.

- [ ] Log in as admin → open EventRosterSheet → Guests section visible.
- [ ] Click Remove on the guest row.
- [ ] **Expect:** Guest row disappears; Guests section disappears if that was the only guest.
- [ ] Check DB:
  ```sql
  select count(*) from event_guests where event_id = '<event-id>';
  -- Expect: count decreased by 1
  ```
- [ ] Check audit_log:
  ```sql
  select action, metadata from audit_log
  where action = 'admin_remove_guest'
  order by created_at desc limit 1;
  -- Expect: row present
  ```

---

## 10. Remove Guest frees a slot and advances waitlist (19B)

**Setup:** Event at capacity (e.g., cap = 2, 1 confirmed + 1 guest). Member B is waitlisted.

- [ ] Admin removes the guest.
- [ ] Check DB:
  ```sql
  select profile_id, status from event_participants
  where event_id = '<event-id>' and profile_id = '<member-b-id>';
  -- Expect: status = 'offered' (waitlist advanced after guest removal)
  ```

---

## 11. Add Member (19B / 19C)

**Setup:** Event with at least one open slot. Member B is not yet in the event.

- [ ] Log in as admin → open EventRosterSheet → `+ Add Member` button visible.
- [ ] Click `+ Add Member` → dropdown appears with eligible members.
- [ ] **Expect:** Member B appears in the list. Members already confirmed/offered/waitlisted do NOT appear.
- [ ] Select Member B → click Add.
- [ ] **Expect:** Roster refreshes; Member B appears in Confirmed section.
- [ ] Check DB:
  ```sql
  select profile_id, status from event_participants
  where event_id = '<event-id>' and profile_id = '<member-b-id>';
  -- Expect: status = 'confirmed'
  ```
- [ ] Check audit_log:
  ```sql
  select action, metadata from audit_log
  where action = 'admin_add_member'
  order by created_at desc limit 1;
  -- Expect: row present
  ```

---

## 12. Add Member — full event waitlists (19B / 19C)

**Setup:** Event at capacity. Member C is not in the event.

- [ ] Admin opens Add Member → selects Member C → clicks Add.
- [ ] **Expect:** Roster refreshes; Member C appears in Waitlist section (not Confirmed).
- [ ] Check DB — Member C: `status = 'waitlisted'`.

---

## 13. Add Member — reactivate cancelled row (19B / 19C)

**Setup:** Member D previously joined and left the event (has a `cancelled` row).

- [ ] Member D should appear in the Add Member dropdown (cancelled rows excluded from active-in-event check).
- [ ] Select Member D → Add.
- [ ] **Expect:** Member D added as confirmed (or waitlisted if full).
- [ ] Check DB — Member D: `status = 'confirmed'` (or `'waitlisted'`), not duplicated.

---

## 14. Add Member — already joined is rejected (19B)

**Setup:** Member A is already confirmed.

- [ ] Member A should NOT appear in the Add Member dropdown (filtered out client-side).
- [ ] If somehow called directly (DB test): `admin_add_member` should return `already_joined`.
  ```sql
  select admin_add_member('<event-id>', '<member-a-id>');
  -- Expect: raises exception 'already_joined'
  ```

---

## 15. Remove confirmed participant (19B / 19C)

- [ ] Log in as admin → EventRosterSheet → Confirmed section.
- [ ] A non-host participant row shows a **Remove** button.
- [ ] Click Remove → roster refreshes → member gone from Confirmed.
- [ ] Check DB: `status = 'cancelled'`.
- [ ] Check audit_log: `action = 'admin_remove_participant'`.

---

## 16. Remove participant frees slot and advances waitlist (19B)

**Setup:** Full event. Member B on waitlist.

- [ ] Admin removes a confirmed participant.
- [ ] Check DB — Member B: `status = 'offered'` with `offer_expires_at` set.

---

## 17. Host row has no Remove button (19C)

- [ ] EventRosterSheet Confirmed section: the host row shows "Host" subtext.
- [ ] **Expect:** No Remove button on the host row.

---

## 18. Force Confirm — waitlisted member (19B / 19C)

**Setup:** Full event. Member B on waitlist.

- [ ] Admin → EventRosterSheet → Waitlist section → click **Force Confirm** on Member B.
- [ ] **Expect:** Roster refreshes; Member B moves to Confirmed.
- [ ] Check DB: `status = 'confirmed'`.
- [ ] Check DB — capacity is NOT enforced (member confirmed even though event is full).
- [ ] Check audit_log: `action = 'admin_force_confirm'`.

---

## 19. Force Confirm — offered member (19B / 19C)

**Setup:** Member B has `status = 'offered'`.

- [ ] Admin → EventRosterSheet → Offered section → click **Force Confirm** on Member B.
- [ ] **Expect:** Member B moves from Offered to Confirmed.
- [ ] Check DB: `status = 'confirmed'`, `offer_expires_at = null`.

---

## 20. Offer Spot — manual FIFO bypass (19B / 19C)

**Setup:** Multiple members waitlisted. Member B is #2 (not #1).

- [ ] Admin → Waitlist section → click **Offer Spot** on Member B (#2).
- [ ] **Expect:** Member B moves to Offered section with `offer_expires_at` set.
- [ ] Member A (#1) remains waitlisted.
- [ ] Check audit_log: `action = 'admin_offer_spot'`, metadata contains `skipped_profile_ids`.

---

## 21. Offer Spot — blocked when active offer exists (19B / 19C)

**Setup:** One member already has `status = 'offered'`. Another is waitlisted.

- [ ] Admin → click **Offer Spot** on the second waitlisted member.
- [ ] **Expect:** Error message "Another member already has an active offer. Expire that offer first."
- [ ] No new offered row created.

---

## 22. Offer Spot — blocked when event is full with no active offer (19B / 19C)

**Setup:** Event exactly at capacity (confirmed + offered + guests = capacity). Member waitlisted.

- [ ] Admin → click **Offer Spot** on waitlisted member.
- [ ] **Expect:** Error message "There is no open spot to offer."

---

## 23. Expire Offer (19B / 19C)

**Setup:** Member B has `status = 'offered'`.

- [ ] Admin → Offered section → click **Expire** on Member B.
- [ ] **Expect:** Member B's row disappears from roster (status → cancelled).
- [ ] **Expect:** Waitlist does NOT auto-advance (no new offer created).
- [ ] Check DB: `status = 'cancelled'`, `offer_expires_at = null`.
- [ ] Check audit_log: `action = 'admin_expire_offer'`.

---

## 24. Permission gates — member sees no admin controls (19C)

- [ ] Log in as regular member → open EventRosterSheet from Calendar or `/events`.
- [ ] **Expect:** No `+ Add Member`, no `+ Add Guest`, no Remove/Force Confirm/Offer Spot/Expire buttons.
- [ ] **Expect:** Roster rows show names only (confirmed and waitlisted sections, no guest section unless guests exist — in which case guest names show but without Remove).

---

## 25. Permission gates — pro user sees admin controls (19C)

- [ ] Log in as pro → open EventRosterSheet.
- [ ] **Expect:** `+ Add Member`, `+ Add Guest`, Remove/Force Confirm/Offer Spot/Expire all visible.
- [ ] Test at least one action (e.g., Add Guest) to confirm it succeeds.

---

## 26. Per-row loading and error state (19C)

- [ ] While a Remove/Force Confirm/Offer Spot/Expire action is in flight, button shows `…` and is disabled.
- [ ] On RPC error, error message appears below the affected row.
- [ ] Other rows remain interactive during a per-row action.

---

## 27. Admin events page — access and content (19D)

- [ ] Log in as admin → Profile → Admin section → **Events** link present → navigate to `/admin/events`.
- [ ] **Expect:** Page loads with "All Events" heading.
- [ ] **Expect:** Events listed newest-first (check `starts_at` ordering across several cards).
- [ ] **Expect:** Each card shows: type pill, status badge (Scheduled/Cancelled), title, date/time, occupancy, roster button (if scheduled).

---

## 28. Admin events page — pro access (19D)

- [ ] Log in as pro → Profile → Admin section → **Events** link present.
- [ ] **Expect:** Members/Courts/Settings/Audit Log links NOT shown for pro (admin-only).
- [ ] Navigate to `/admin/events` → page loads correctly.

---

## 29. Admin events page — member blocked (19D)

- [ ] Log in as regular member → navigate directly to `/admin/events`.
- [ ] **Expect:** Redirect to `/calendar` (layout guard).

---

## 30. Admin events page — cancelled event display (19D)

- [ ] Cancel an event or confirm at least one cancelled event exists.
- [ ] In `/admin/events`: cancelled events show "Cancelled" badge, muted appearance (50% opacity).
- [ ] Cancelled events have no Roster button.

---

## 31. Admin events page — Load More (19D)

- [ ] If the club has more than 25 events, scroll to the bottom of `/admin/events`.
- [ ] **Expect:** **Load more** button present.
- [ ] Click it → next batch of events appended to the list.
- [ ] When no more events remain, button disappears.

---

## 32. Capacity display — guests included everywhere (19D)

**Setup:** Event with capacity = 3. Member A confirmed, Member B offered, Guest "Alex" added. Total occupied = 3.

- [ ] **EventDetailSheet (Calendar):** shows `3 of 3 spots filled`.
- [ ] **`/events` page card:** shows `3 / 3 joined`.
- [ ] **`/admin/events` card:** shows `3 / 3 filled`.
- [ ] **View Roster button label:** count includes guests (e.g., "View Roster (3)" or more if waitlisted).

---

## 33. isFull gate includes guests (19D)

**Setup:** Event capacity = 2. One confirmed participant + one guest = 2 occupied.

- [ ] Log in as a member who hasn't joined → open EventDetailSheet.
- [ ] **Expect:** Button shows **Join Waitlist** (not Join Event) — guests fill capacity.
- [ ] Click Join Waitlist → member placed on waitlist (not confirmed).
- [ ] Check DB: `status = 'waitlisted'`.

---

## 34. Waitlist count excludes guests (19D)

- [ ] On `/events` page, confirm the waitlist count next to capacity only reflects `status = 'waitlisted'` participants — not guests.
- [ ] EventDetailSheet capacity line: `· N on waitlist` count is correct (guests not counted in waitlist).

---

## 35. Audit log labels (19C / 19D)

- [ ] Perform one each of: admin_add_member, admin_remove_participant, admin_force_confirm, admin_offer_spot, admin_expire_offer, admin_add_guest, admin_remove_guest.
- [ ] Navigate to `/admin/audit-log`.
- [ ] **Expect:** Each action appears with its human-readable label:

  | DB action                  | Label shown in UI               |
  | -------------------------- | ------------------------------- |
  | admin_add_member           | Added member to event           |
  | admin_remove_participant   | Removed participant from event  |
  | admin_force_confirm        | Force confirmed participant     |
  | admin_offer_spot           | Manually offered spot           |
  | admin_expire_offer         | Expired offer                   |
  | admin_add_guest            | Added guest to event            |
  | admin_remove_guest         | Removed guest from event        |

---

## 36. Regression — member join and leave (unaffected)

- [ ] Non-full event: member joins → confirmed immediately. Join button → Leave button.
- [ ] Full event: member joins → waitlisted. Join Waitlist button → Leave Waitlist button.
- [ ] Member leaves event → row cancelled; waitlist advances (offer created, NOT direct confirm).
- [ ] Member leaves waitlist → removed; others' positions unchanged.

---

## 37. Regression — waitlist offer flow (unaffected)

- [ ] Member with offered row sees Accept/Pass UI in EventDetailSheet.
- [ ] Accept → `status = 'confirmed'`; `waitlist_promoted` notification created.
- [ ] Pass → `status = 'cancelled'`; next waitlisted member gets offer.
- [ ] Expired offer (set `offer_expires_at` to past) → "Offer expired" badge on `/events`; "Rejoin" button in EventDetailSheet.

---

## 38. Regression — calendar and /events display (unaffected)

- [ ] Calendar shows event blocks on correct courts.
- [ ] EventDetailSheet shows correct date, time, courts, and participant names (if `shows_participant_names` is enabled for that event type).
- [ ] `/events` page groups events by date, ordered ascending.
- [ ] Host sees "You're the Host" (disabled join button) in EventDetailSheet.

---

## 39. Regression — event cancellation (unaffected)

- [ ] Admin cancels a scheduled event.
- [ ] Event disappears from calendar and `/events` (scheduled filter).
- [ ] Participants notified (check `event_cancelled` notifications).
- [ ] Offered rows cancelled; `offer_expires_at` cleared.

---

## 40. Build and deploy checks

```bash
# Run locally before pushing
pnpm tsc --noEmit
# Expect: no output (zero errors)

pnpm build
# Expect: build succeeds; /admin/events listed as a dynamic route in the output
```

- [ ] `pnpm tsc --noEmit` — zero errors.
- [ ] `pnpm build` — succeeds; `/admin/events` present in route table.
- [ ] Push to main branch → Vercel deployment succeeds (no build errors in deployment log).
- [ ] Spot-check one page in the deployed environment (e.g., `/admin/events`) to confirm it loads correctly.

---

## Sign-off

| #  | Area                                              | Status |
| -- | ------------------------------------------------- | ------ |
| 1  | event_guests schema                               | ☐      |
| 2  | get_event_roster returns guests                   | ☐      |
| 3  | Capacity formula includes guests                  | ☐      |
| 4  | Admin RPCs present (7)                            | ☐      |
| 5  | Admin RPCs are SECURITY DEFINER                   | ☐      |
| 6  | Add Guest — basic flow                            | ☐      |
| 7  | Add Guest — blank name rejected                   | ☐      |
| 8  | Add Guest — Enter key submits                     | ☐      |
| 9  | Remove Guest                                      | ☐      |
| 10 | Remove Guest frees slot and advances waitlist     | ☐      |
| 11 | Add Member                                        | ☐      |
| 12 | Add Member — full event waitlists                 | ☐      |
| 13 | Add Member — reactivate cancelled row             | ☐      |
| 14 | Add Member — already joined rejected              | ☐      |
| 15 | Remove confirmed participant                      | ☐      |
| 16 | Remove participant advances waitlist              | ☐      |
| 17 | Host row has no Remove button                     | ☐      |
| 18 | Force Confirm — waitlisted                        | ☐      |
| 19 | Force Confirm — offered                           | ☐      |
| 20 | Offer Spot — manual FIFO bypass                   | ☐      |
| 21 | Offer Spot — blocked by active offer              | ☐      |
| 22 | Offer Spot — blocked when full                    | ☐      |
| 23 | Expire Offer                                      | ☐      |
| 24 | Member sees no admin controls                     | ☐      |
| 25 | Pro sees admin controls                           | ☐      |
| 26 | Per-row loading and error state                   | ☐      |
| 27 | Admin events page — content                       | ☐      |
| 28 | Admin events page — pro access                    | ☐      |
| 29 | Admin events page — member blocked                | ☐      |
| 30 | Admin events page — cancelled events              | ☐      |
| 31 | Admin events page — Load More                     | ☐      |
| 32 | Capacity display includes guests everywhere       | ☐      |
| 33 | isFull gate includes guests                       | ☐      |
| 34 | Waitlist count excludes guests                    | ☐      |
| 35 | Audit log labels (7 actions)                      | ☐      |
| 36 | Regression — member join and leave                | ☐      |
| 37 | Regression — waitlist offer flow                  | ☐      |
| 38 | Regression — calendar and /events display         | ☐      |
| 39 | Regression — event cancellation                   | ☐      |
| 40 | Build and deploy checks                           | ☐      |
