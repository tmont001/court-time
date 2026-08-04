# Phase 30D — Admin Maintenance-Block Editing — QA

Scope: `update_maintenance_block` (migration
`0100_maintenance_edit_foundation.sql`), the admin maintenance-edit UI
(`ReservationDetailSheet` + new `EditMaintenanceSheet`), and the
`updateMaintenanceBlock` Server Action in
`src/app/(app)/calendar/actions.ts`.

Locked product decision (Phase 30D audit): maintenance blocks have **no
durable multi-court group identity** in this schema.
`create_maintenance_blocks` inserts one independent `reservations` row per
court with no shared group/batch id. Editing always targets exactly the one
reservation row the admin clicked — never a reconstructed "group." Adding a
court to an existing block remains **Create Maintenance Block**; removing a
court from a block remains **cancelling that individual row** via the
existing, unchanged `admin_cancel_reservation` RPC.

Event, lesson, program, and personal (`member_booking`) reservation editing
are all out of scope and unaffected by this checkpoint — see
`QA_phase30b1.md`/`QA_phase30c.md` for those.

Run every case below against a non-production/staging Supabase project.
Migration `0100` must be applied there first.

---

## 1. Authorization

- [ ] **Admin edits an eligible maintenance block** — succeeds; `changed_fields`
      lists exactly the fields that differ from the prior values.
- [ ] **Pro calls `update_maintenance_block` directly** → `insufficient_role`.
- [ ] **Member calls `update_maintenance_block` directly** → `insufficient_role`.
- [ ] **Null/unresolvable active membership** (`current_user_club_id()`
      returns null) → `not_authenticated`, checked before role.
- [ ] **Stale `p_expected_club_id`** (doesn't match `current_user_club_id()`)
      → `stale_club_context`.
- [ ] Confirm the RPC never reads `profiles.club_id`/`profiles.role`
      directly — only `current_user_club_id()`/`current_user_role()` plus
      the caller-supplied `p_expected_club_id`.

## 2. Eligibility

- [ ] **Wrong-club reservation ID** (valid ID, different club) →
      `reservation_not_found`.
- [ ] **Unknown reservation ID** → `reservation_not_found`.
- [ ] **`reason = 'member_booking'` row** → `reservation_not_editable`.
- [ ] **`reason = 'event'` row** (a reservation linked to an event) →
      `reservation_not_editable`.
- [ ] **`reason = 'pro_lesson'` row** → `reservation_not_editable`.
- [ ] **`status = 'cancelled'` maintenance row** → `reservation_not_editable`.
- [ ] **Already-started block** (`starts_at <= now()`) →
      `cannot_edit_started_reservation`.
- [ ] **Past block** (well in the past) → `cannot_edit_started_reservation`
      (same rule, no separate "past" code).

## 3. Stale-edit conflict

- [ ] **Stale `p_expected_updated_at`** (doesn't match the row's current
      `updated_at`, e.g. after a concurrent edit) → `stale_edit_conflict`;
      confirm the row is completely unchanged afterward.

## 4. No-op behavior

- [ ] **True no-op** — every parameter resubmitted identical to the row's
      current values → RPC returns successfully with `changed_fields: []`;
      confirm via direct query that `updated_at` is unchanged and **no**
      new `audit_log` row exists.

## 5. Editable-field behavior

- [ ] Edit `court_id` only (move the block to a different active court in
      the same club) — succeeds; `changed_fields = ['court_id']`; the row
      keeps the same `id`.
- [ ] Edit `starts_at`/`ends_at` only (reschedule) — succeeds;
      `changed_fields` includes both if both changed.
- [ ] Edit `notes` only — succeeds; `changed_fields = ['notes']`.
- [ ] Edit `show_notes_to_members` only — succeeds;
      `changed_fields = ['show_notes_to_members']`.
- [ ] Edit every field at once (court, time, notes, visibility) — succeeds;
      `changed_fields` contains all of them.
- [ ] Set `notes` to `null`/empty — succeeds; confirm the row's `notes`
      becomes `null`, not an empty string mismatch.

## 6. Never-touched columns

- [ ] For any successful edit, confirm `owner_user_id` is **unchanged**
      (remains the original creating admin's id, never the editor's).
- [ ] Confirm `created_by` is **unchanged**.
- [ ] Confirm `reason` remains `'maintenance'`.
- [ ] Confirm `status` remains `'confirmed'`.
- [ ] Confirm `event_id` is unchanged (`null`, as for all maintenance rows).
- [ ] Confirm `cancelled_at`/`cancelled_by`/`cancellation_kind` are
      untouched (still `null` for an active block).
- [ ] Repeat the above with **Admin B editing a block created by Admin A**
      — confirm `owner_user_id`/`created_by` still show Admin A, while the
      `audit_log` row's `actor_id` correctly shows Admin B as the editor.

## 7. Validation

- [ ] `p_ends_at <= p_starts_at` → `invalid_duration`.
- [ ] `p_starts_at` in the past → `cannot_edit_to_past`.
- [ ] `p_court_id` referencing an inactive court → `invalid_court`.
- [ ] `p_court_id` referencing a court from a **different club** →
      `invalid_court`.
- [ ] `p_court_id` referencing a nonexistent court → `invalid_court`.

## 8. GiST conflict / rollback behavior

- [ ] Edit a block's court/time into a slot already occupied by an
      unrelated reservation/event/maintenance block/lesson on that court →
      Postgres `23P01`; confirm the **entire** call rolled back — the row's
      own values unchanged, no audit row, `updated_at` unchanged.
- [ ] Edit only `notes`/`show_notes_to_members` (no court/time change) on a
      block whose *current* court/time already conflicts with something
      created after it (if reachable) — should still succeed, since the
      exclusion constraint only re-validates the row being updated at its
      *new* proposed range, not unrelated existing conflicts elsewhere.

## 9. Off-hours / closed-date parity (documented, not a bug)

- [ ] **Confirm, not fix**: edit a maintenance block's time into a slot
      outside the club's weekly `operating_hours`, or on a closed-date
      `operating_hours_override` — the edit **succeeds** (no
      `outside_operating_hours`/`club_closed_this_day` error), exactly
      matching `create_maintenance_block(s)`'s existing, unchanged
      behavior. This is deliberate parity — maintenance work is expected to
      happen off-hours — and `update_maintenance_block` must not become
      stricter than creation.

## 10. Legacy multi-court creation — individual-row behavior

- [ ] Using an **existing** maintenance block that was originally created
      via `create_maintenance_blocks` with multiple courts (i.e. several
      reservation rows share the same original `starts_at`/`ends_at`/
      `notes`/`created_by`, with no group column tying them together),
      edit **one** of those sibling rows (e.g. change its time or notes) —
      confirm only that single reservation row changes.
- [ ] Confirm every **other** sibling row from that same original creation
      call is **completely unaffected** — same `court_id`, `starts_at`,
      `ends_at`, `notes`, `show_notes_to_members`, `updated_at` as before
      the edit. There is no group propagation of any kind.
- [ ] Confirm the edited row's `notes`/`show_notes_to_members` may now
      legitimately diverge from its former siblings — this is expected,
      not a bug, since each row is independently editable.

## 11. Audit-log assertions

- [ ] For any successful, non-no-op edit, confirm exactly one new
      `audit_log` row: `action='update_maintenance_block'`,
      `target_type='reservation'`, `target_id=<reservation id>`, and
      `metadata` contains `changed_fields` plus structured `before`/`after`
      objects for `court_id`/`starts_at`/`ends_at`/`notes`/
      `show_notes_to_members`.
- [ ] Confirm **no** `notifications` row is ever created by
      `update_maintenance_block` (maintenance blocks have no
      participant/customer to notify — this is unlike `update_event`/
      `update_member_reservation`, which do create notifications for
      material changes).

---

## 12. UI — ReservationDetailSheet / EditMaintenanceSheet (manual)

- [ ] As Admin, click an eligible future maintenance block on **Calendar**
      — `ReservationDetailSheet` shows an **Edit Block** button (not the
      generic "Edit" label used for member bookings).
- [ ] Tap **Edit Block** — `EditMaintenanceSheet` opens as a nested child
      sheet; the parent `ReservationDetailSheet` visually suspends
      (`active={false}`), matching the existing member-booking edit
      nested-sheet convention exactly (same z-index/backdrop/draggable
      stack as `EditReservationSheet`).
- [ ] Change the court, date/time, duration, notes, and the "Show this
      message to members" toggle in one save — confirm the save succeeds,
      both sheets close, and Calendar reflects every change (correct
      day/slot/court, updated block label for admin/pro viewers).
- [ ] Cancel out of the edit via **Discard** — confirm no changes were
      submitted and the block is unchanged on reload.
- [ ] **Stale conflict**: open the same block for edit in two sessions;
      save in the first, then attempt a different save in the second
      (now-stale) session — confirm the inline amber "This block was
      changed by someone else" banner appears with a **Reload** action,
      and the save is **not** applied. Tap **Reload** — confirm the form
      resets to the block's current (post-first-edit) values and the
      banner clears.
- [ ] **Conflict**: attempt to move a block onto a court/time already
      occupied by another active reservation — confirm the friendly
      "That court already has a booking at the selected time" message
      appears (mapped from Postgres `23P01`), not a raw error code.
- [ ] **Duration**: select each preset (30/60/90/120/240 min) and confirm
      "ends {time}" updates correctly; select **Custom**, enter an invalid
      value (0, negative, non-numeric) — confirm Save is disabled and an
      inline validation message appears; enter a valid custom value (e.g.
      480 for an all-day block) — confirm Save re-enables and succeeds.
- [ ] **Mobile**: confirm `EditMaintenanceSheet` is draggable independently
      of the parent sheet, dismissible by its own drag gesture without
      affecting `ReservationDetailSheet` underneath; confirm date/duration
      inputs use the mobile-safe `.ct-input`/`.ct-date-input` classes (no
      iOS zoom-on-focus).
- [ ] Close `EditMaintenanceSheet` without saving — confirm focus/
      interactivity correctly returns to `ReservationDetailSheet`
      (Escape/backdrop-click work normally again).

## 13. Eligibility and visibility (manual)

- [ ] A **future, confirmed** maintenance block shows **Edit Block** for
      Admin.
- [ ] An **already-started or past** maintenance block does **not** show
      Edit Block (only Cancel Block, if still cancellable by existing
      rules — unaffected by this checkpoint).
- [ ] A **cancelled** maintenance block does not show Edit Block.
- [ ] A **Pro** viewing a maintenance block never sees Edit Block (creation
      and editing remain Admin-only — no Pro exception, unlike event
      creator-Pro cancellation).
- [ ] A **Member** viewing a maintenance block (via the "Blocked" rendering
      on Calendar, if visible to members at all) never sees Edit Block —
      members cannot open `ReservationDetailSheet` in admin mode.

## 14. Cancel Block — unchanged (regression)

- [ ] **Cancel Block** (relabeled from "Cancel Booking" for
      `reason='maintenance'` rows only) still calls the existing, unchanged
      `admin_cancel_reservation` RPC and successfully cancels the single
      clicked row, exactly as before this checkpoint.
- [ ] Confirm a maintenance block's sibling rows (from the same original
      multi-court creation call) are unaffected by cancelling one of them —
      matches §10's no-group-propagation finding.
- [ ] Confirm member-booking **Cancel Booking** wording and behavior are
      completely unchanged.

## 15. Regression — personal bookings, events, lessons unaffected

- [ ] **Member personal court-booking edit/cancel** (via `EditReservationSheet`/
      `cancel_member_reservation`) continues to work exactly as before —
      completely untouched by this checkpoint.
- [ ] **Event editing** (`EditEventSheet`/`update_event`, Phase 30C) is
      unaffected — no shared code path was modified.
- [ ] **Pro lesson reservations** (`reason='pro_lesson'`) are unaffected —
      still rendered via the dedicated lesson block path in `CalendarShell`,
      never routed through `EditMaintenanceSheet`.
- [ ] Confirm `docs/QA_phase30b1.md`'s existing baseline case — "Open a
      maintenance block as admin — Edit is hidden" — is now **superseded**
      by this checkpoint (Edit Block is now shown); re-run that file's
      other, unrelated member-booking cases to confirm they still pass
      unchanged.
