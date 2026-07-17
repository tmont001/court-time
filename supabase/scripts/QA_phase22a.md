# QA Record — Phase 22A

## Club Configuration Completeness

This document covers manual QA for all Phase 22A deliverables:
- Club Timezone Management (Admin Settings)
- Event Type Management (Admin Settings)
- member_joinable toggle (Admin Events)

---

## Migrations

### Application order

Apply via Supabase SQL Editor in this exact order:

1. **0064** — `update_club_timezone` RPC
2. **0065** — Event type management (is_active, three RPCs, trigger)
3. **0066** — `set_event_member_joinable` RPC + `delete_event_type` RPC

Each migration is fully idempotent. If a migration fails partway through,
it is safe to rerun it from the beginning.

---

### 0064 — update_club_timezone

**What it does:**
- Adds `update_club_timezone(p_timezone text)` — SECURITY DEFINER, admin-only.
- Validates explicit null and rejects unsupported IANA identifiers.
- Updates `clubs.timezone`; writes to `audit_log`.
- REVOKE from PUBLIC/anon; GRANT to authenticated.

**Rerun safety:** CREATE OR REPLACE + REVOKE/GRANT. No schema changes.

---

### 0065 — Event type management

**What it does:**
1. Removes `event_types_key_check` constraint (was limiting to 5 values).
2. Adds `is_active boolean not null default true`.
3. Adds RLS INSERT/UPDATE policies for admins (defense-in-depth).
4. Adds three RPCs: `create_event_type`, `update_event_type`, `set_event_type_active`.
5. Adds `check_event_type_active()` trigger on `events` (BEFORE INSERT or UPDATE OF
   event_type_id — blocks inactive types from being assigned to new or updated events).

**Rerun safety:** DROP POLICY/TRIGGER IF EXISTS + CREATE OR REPLACE + REVOKE/GRANT.

**Rollback (before any data is written):**
```sql
drop trigger  if exists events_check_event_type_active on events;
drop function if exists check_event_type_active();
drop function if exists set_event_type_active(uuid, boolean);
drop function if exists update_event_type(uuid, text, text);
drop function if exists create_event_type(text, text);
drop policy   if exists "event_types_update_admin" on event_types;
drop policy   if exists "event_types_insert_admin" on event_types;
alter table event_types drop column if exists is_active;
alter table event_types add constraint event_types_key_check
  check (key in ('lesson','clinic','social','league','tournament'));
```

---

### 0066 — set_event_member_joinable + delete_event_type

**What it does:**

`set_event_member_joinable(p_event_id uuid, p_member_joinable boolean)`:
- Admin or pro, club-scoped.
- Rejects null event_id and null member_joinable.
- Guards: event_not_found, event_cancelled, event_archived.
- Server-side future guard: `starts_at <= now()` → `event_started`.
  The UI restricts to future events; this guard ensures a stale client or
  direct RPC call cannot change a past event.
- Pro ownership guard: pro may only change events they created.
- Updates `events.member_joinable`; writes to `audit_log`.
- REVOKE from PUBLIC/anon; GRANT to authenticated.

`delete_event_type(p_id uuid)`:
- Admin only, club-scoped.
- Rejects null p_id.
- Guards: not_found, protected_event_type (seeded keys), event_type_active,
  event_type_in_use (any event references this type_id).
- Writes to `audit_log` **before** DELETE so the record survives.
- REVOKE from PUBLIC/anon; GRANT to authenticated.

**Rerun safety:** CREATE OR REPLACE + REVOKE/GRANT. No schema changes.

**Rollback:**
```sql
drop function if exists delete_event_type(uuid);
drop function if exists set_event_member_joinable(uuid, boolean);
```

---

## Setup checklist

- [ ] Apply migration 0064 via Supabase SQL Editor.
- [ ] Apply migration 0065 via Supabase SQL Editor.
- [ ] Apply migration 0066 via Supabase SQL Editor.
- [ ] Verify `event_types` rows all have `is_active = true`:
  ```sql
  select key, label, color, is_active from event_types order by key;
  ```
- [ ] Verify trigger exists:
  ```sql
  select tgname from pg_trigger where tgname = 'events_check_event_type_active';
  ```
- [ ] Verify both new functions exist:
  ```sql
  select proname from pg_proc
  where proname in ('set_event_member_joinable','delete_event_type');
  ```
- [ ] Start local dev: `pnpm dev`. Sign in as Admin.

---

## A. Migration rerun safety

- [ ] Rerun migration 0064. Confirm it completes without error.
- [ ] Rerun migration 0065. Confirm it completes without error
      (no "policy already exists" or "trigger already exists").
- [ ] Rerun migration 0066. Confirm it completes without error.

---

## B. Timezone — Admin Settings display and labels

- [ ] Navigate to `/admin/settings` as Admin.
- [ ] Confirm "Club Timezone" section appears between Club Branding and Event Types.
- [ ] Confirm the dropdown shows these exact labels (no duplicates):
  - Eastern Time — New York
  - Central Time — Chicago
  - Mountain Time — Denver
  - Arizona Time — Phoenix, no daylight saving
  - Pacific Time — Los Angeles
  - Alaska Time — Anchorage
  - Hawaii Time — Honolulu
- [ ] Confirm helper text appears below the first paragraph:
  "Court Time currently supports United States time zones. The city identifies
  the time-zone region and is not saved as the club's physical location."
- [ ] Change timezone and press **Save**. Confirm "Saved" success.
- [ ] Reload page; confirm new timezone pre-selected.
- [ ] Confirm `audit_log` entry:
  ```sql
  select action, metadata, created_at from audit_log
  where action = 'update_club_timezone' order by created_at desc limit 3;
  ```

---

## C. Timezone — Null and invalid rejection

- [ ] Confirm null rejected:
  ```sql
  select update_club_timezone(null);
  -- Expected: ERROR: invalid_timezone
  ```
- [ ] Confirm unsupported timezone rejected:
  ```sql
  select update_club_timezone('Europe/London');
  -- Expected: ERROR: invalid_timezone
  ```

---

## D. Timezone — Pro/member access denial

- [ ] Sign in as Pro. Navigate to `/admin/settings`. Confirm redirect.
- [ ] Sign in as Member. Navigate to `/admin/settings`. Confirm redirect.

---

## E. Timezone — Calendar and event display regression

- [ ] Note current timezone and a displayed event time.
- [ ] Change to Pacific (America/Los_Angeles) and save.
- [ ] Confirm Calendar, /my-schedule, /events, Admin Events, and Operating Hours
      all reflect Pacific offsets.
- [ ] Revert to original timezone; confirm times revert.

---

## F. Event Types — Color swatches and badge preview

### F1. Edit mode

- [ ] Click **Edit** on any seeded type (e.g. Group Clinic).
- [ ] Confirm the native color picker is gone; eight swatches appear:
      Blue, Green, Orange, Purple, Red, Teal, Gold, Slate.
- [ ] Confirm the currently saved color swatch is highlighted (scaled and
      bordered).
- [ ] If the saved color is not one of the eight presets, confirm a custom
      color chip appears (selected-ring, non-clickable) alongside the presets.
- [ ] Click a different swatch. Confirm that swatch becomes highlighted and the
      badge preview at the top of the edit form updates immediately.
- [ ] Type a new label. Confirm the badge preview reflects the new text.
- [ ] Press **Cancel**. Confirm no change was saved; swatch resets to saved color.

### F2. Create mode

- [ ] Click **+ Add event type**.
- [ ] Confirm badge preview shows at the top of the create form.
- [ ] Select swatches and type a label; confirm preview updates live.
- [ ] Press **Cancel**. Confirm form is dismissed and no type was created.

### F3. Hex values

- [ ] Confirm no hex string (`#3B7DD8`, etc.) is visible as primary UI
      anywhere in the event type section.

### F4. Mobile layout at 375px

- [ ] Open Settings at 375px viewport.
- [ ] Confirm eight swatches fit without horizontal overflow.
- [ ] Confirm badge preview, label input, and Save/Cancel buttons are usable.

---

## G. Event Types — Edit, Cancel, and Undo

### G1. Save and Undo

- [ ] Edit a seeded type. Change label to "TEST". Save.
- [ ] Confirm row shows "Saved." and **Undo** link immediately after save.
- [ ] Confirm Undo is linked to the edited row only (not other rows).
- [ ] Press **Undo**. Confirm label reverts to the previous value.
- [ ] Confirm "Saved." / Undo disappears after undo completes.
- [ ] Undo does not appear after a page refresh (undo history is ephemeral).

### G2. Undo failure

- [ ] Simulate an Undo failure (e.g., block the network after save).
- [ ] Confirm inline error appears on the row: "Failed to update event type."
      or a specific code-mapped message.
- [ ] Confirm Undo link remains (so user can retry or reload).

### G3. Cancel before saving

- [ ] Click **Edit** on a type. Change the label. Click **Cancel**.
- [ ] Confirm no API call was made; the row shows the original label.

---

## H. Event Types — Restore default (seeded types)

### H1. Restore available when values differ

- [ ] Edit "Group Clinic". Change label to "MY CLINIC". Save.
- [ ] Confirm row now shows **Restore default** in addition to Edit / Deactivate.
- [ ] Click **Restore default**. Confirm inline confirmation:
  "Restore 'MY CLINIC' to defaults? Label will change to Group Clinic and
  color will reset to [swatch]."
- [ ] Press **Keep current**. Confirm no change; confirmation dismissed.
- [ ] Click **Restore default** again. Press **Restore default** to confirm.
- [ ] Confirm label and color revert to "Group Clinic" / #2E9B5E.
- [ ] Confirm **Undo** appears after the restore (allows reverting the restore).
- [ ] Confirm **Restore default** disappears when label and color match defaults.

### H2. Authoritative defaults

| key        | label         | color   |
|------------|---------------|---------|
| lesson     | Private Lesson | #3B7DD8 |
| clinic     | Group Clinic  | #2E9B5E |
| social     | Open Social   | #E68433 |
| league     | League Match  | #7B4FB5 |
| tournament | Tournament    | #C44545 |

### H3. Restore not available for custom types

- [ ] Create a custom type "Round Robin".
- [ ] Confirm **Restore default** is never shown for this row.

---

## I. Event Types — Deactivation (with confirmation)

- [ ] Click **Deactivate** on "League Match".
- [ ] Confirm inline confirmation appears: "Deactivate 'League Match'? This type
      will be hidden from Create Event. Existing events are unaffected."
- [ ] Press **Keep active**. Confirm type stays active.
- [ ] Click **Deactivate** again. Press **Deactivate** to confirm.
- [ ] Confirm type moves to Inactive section with strikethrough.
- [ ] Confirm "League Match" is absent from Create Event Step 1.
- [ ] Confirm existing league events on Calendar still show the badge.

### I1. DB trigger blocks inactive type on insert

```sql
insert into events (club_id, event_type_id, title, starts_at, ends_at, capacity,
  created_by, status, member_joinable)
select club_id, id, 'Test', now() + interval '1 day',
  now() + interval '1 day 1 hour', 1,
  (select id from profiles limit 1), 'scheduled', true
from event_types where key = 'league' limit 1;
-- Expected: ERROR: inactive_event_type
```

---

## J. Event Types — Reactivation

- [ ] Click **Reactivate** on the deactivated "League Match".
- [ ] Confirm it moves to Active section; **Restore default** / **Deactivate**
      buttons return.

---

## K. Event Types — Delete (inactive custom types only)

### K1. Delete flow

- [ ] Create custom type "Test Type". Deactivate it.
- [ ] Confirm **Delete** appears in the inactive row (alongside Reactivate).
- [ ] Click **Delete**. Confirm inline confirmation: "Delete 'Test Type'
      permanently? This cannot be undone."
- [ ] Press **Keep**. Confirm type remains.
- [ ] Click **Delete** again. Press **Delete permanently** to confirm.
- [ ] Confirm row is removed from the list.
- [ ] Confirm `audit_log` entry:
  ```sql
  select action, metadata from audit_log
  where action = 'delete_event_type' order by created_at desc limit 3;
  ```

### K2. Seeded types never show Delete

- [ ] Deactivate any seeded type (e.g. Tournament).
- [ ] Confirm **Delete** never appears on that row (only Reactivate / Restore default).

### K3. Referenced type deletion blocked

- [ ] Create an event using custom type "Used Type". Deactivate "Used Type".
- [ ] Attempt RPC call:
  ```sql
  select delete_event_type('<used-type-id>');
  -- Expected: ERROR: event_type_in_use
  ```
- [ ] Confirm the UI shows: "This type is used by existing events and cannot be
      deleted." (after attempting delete from UI via direct SQL if needed).

### K4. Active type deletion blocked

```sql
select delete_event_type('<active-type-id>');
-- Expected: ERROR: event_type_active
```

### K5. Protected key deletion blocked

```sql
select delete_event_type('<clinic-type-id>');
-- Expected: ERROR: protected_event_type
```

### K6. Null ID rejection

```sql
select delete_event_type(null);
-- Expected: ERROR: invalid_event_type
```

---

## L. Event Types — GRANT verification

```sql
select proname, proacl from pg_proc
where proname in (
  'create_event_type','update_event_type','set_event_type_active',
  'update_club_timezone','set_event_member_joinable','delete_event_type'
);
-- PUBLIC should not appear in proacl for any of these functions.
```

---

## M. member_joinable toggle — Open to members

### M1. Toggle button appears on eligible events

- [ ] Navigate to Admin Events (Manage tab / /events?tab=manage).
- [ ] Find a future scheduled non-archived event.
- [ ] Confirm "Make admin-managed" button appears in the event action row.
- [ ] Confirm the button is absent on: cancelled events, archived events,
      past events, events the current pro did not create.

### M2. Open → Admin-managed: no active participants

- [ ] Verify the event has zero confirmed, offered, and waitlisted participants.
- [ ] Click "Make admin-managed".
- [ ] Confirm change applies immediately (optimistic update); badge shows
      "Admin-managed".
- [ ] Confirm no confirmation dialog appeared.
- [ ] Confirm `audit_log`:
  ```sql
  select action, metadata from audit_log
  where action = 'set_event_member_joinable' order by created_at desc limit 3;
  ```

### M3. Open → Admin-managed: active participants (confirmation required)

- [ ] Add at least one confirmed participant to a future event.
- [ ] Click "Make admin-managed".
- [ ] Confirm inline confirmation appears showing participant count:
  "X participant(s) are on this event. They will remain on the roster,
  but new members won't be able to self-join from the calendar."
- [ ] Press **Keep open**. Confirm no change; confirmation dismissed.
- [ ] Click "Make admin-managed" again. Press **Make admin-managed** to confirm.
- [ ] Confirm badge updates to "Admin-managed".
- [ ] Confirm existing participants are still on the roster.
- [ ] Confirm the event is no longer visible in the member-facing Upcoming list
      (`/events`).

### M4. Admin-managed → Open: no confirmation

- [ ] Click "Open to members" on an Admin-managed event.
- [ ] Confirm change applies immediately without any confirmation dialog.
- [ ] Confirm event reappears in the member-facing Upcoming list.

### M5. Route revalidation

- [ ] After toggling Open → Admin-managed, navigate to `/events` (member view).
- [ ] Confirm the event is absent from the member Upcoming list.
- [ ] Navigate to `/calendar`. Confirm the event is absent or non-joinable
      depending on member_joinable filtering in those views.

### M6. Server-side future guard (event_started)

- [ ] Confirm the RPC rejects a past event regardless of the UI:
  ```sql
  -- Substitute a past event's ID.
  select set_event_member_joinable('<past-event-id>', false);
  -- Expected: ERROR: event_started
  ```

### M7. Optimistic update and revert on error

- [ ] Block the network after clicking "Make admin-managed" (no confirmation
      required case).
- [ ] Confirm the badge briefly shows "Admin-managed" (optimistic).
- [ ] Confirm the badge reverts when the error response arrives.
- [ ] Confirm an inline error message appears below the action buttons.

### M8. Only one confirmation open at a time

- [ ] Open the Admin-managed confirmation for event A.
- [ ] Click Archive on the same event. Confirm the Admin-managed confirmation
      closes and the Archive confirmation opens.

---

## N. member_joinable toggle — Pro behavior

- [ ] Sign in as Pro.
- [ ] Navigate to Admin Events (Manage).
- [ ] Confirm toggle appears only on the Pro's own future events.
- [ ] Confirm toggle is absent on other pros' or admins' events.
- [ ] Confirm RPC rejects pro changing another pro's event:
  ```sql
  select set_event_member_joinable('<other-pros-event-id>', false);
  -- Expected: ERROR: insufficient_role
  ```

---

## O. Event Types — Historical events (inactive type)

- [ ] With "League Match" inactive, find a past league event.
- [ ] Cancel it via Admin Events. Confirm no "inactive_event_type" error.
- [ ] Archive it. Confirm no error.
- [ ] Confirm badge still shows "League Match" on the archived event.

---

## P. Event Types — Create (symbol/emoji label fallback)

- [ ] Create type "Round Robin". Confirm key is `round_robin` in DB.
- [ ] Create type "!!!" (symbol only). Confirm key is `event_type` or
      `event_type_2` (safe fallback, never empty).
- [ ] Create type "🎾" (emoji only). Confirm key is `event_type` or variant.

---

## Q. Club isolation

- [ ] Confirm Admin B cannot update Admin A's event types or timezone.
- [ ] Confirm `delete_event_type` with another club's type ID returns `not_found`.
- [ ] Confirm `set_event_member_joinable` with another club's event ID returns
      `event_not_found`.

---

## R. Mobile Settings overflow

- [ ] Open `/admin/settings` at 375px viewport.
- [ ] Confirm timezone dropdown does not cause horizontal page overflow.
- [ ] Confirm Event Type rows (swatches, label inputs, confirmation blocks)
      fit without overflow.
- [ ] Confirm admin event action buttons (Make admin-managed, Cancel Event,
      Archive, Unarchive) wrap correctly on narrow screens.
- [ ] Confirm no `overflow-x: hidden` was added to global layout or Calendar.

---

## Issues Log

| # | Section | Description | Severity | Status |
|---|---------|-------------|----------|--------|
|   |         |             |          |        |
