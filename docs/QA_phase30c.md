# Phase 30C — Admin Event Editing — QA

Scope of this document (Phase 30C1 only): `supabase/migrations/0099_event_edit_foundation.sql`
— the new `update_event` RPC, the `event_updated` notification kind, and the
isolated `cancel_event` Pro-ownership correction. **SQL/RPC sections only.**
UI and real-device sections are added in a later Phase 30C slice once the
Calendar and Manage Events integrations exist — do not add them here yet.

Run every case below against a non-production/staging Supabase project.
Migration `0099` must be applied there first.

Out of scope for Phase 30C entirely (per the locked architecture): Pro
event-edit access, editing a whole program's recurrence rules, maintenance-
block editing, lesson rescheduling, public events, payment behavior.

---

## 1. Authorization and eligibility

- [ ] **Admin edits an eligible standalone event** — succeeds; `changed_fields`
      lists exactly the fields that differ from the prior values.
- [ ] **Admin edits an eligible program-generated session** (date/start/
      duration/court/capacity only) — succeeds.
- [ ] **Pro calls `update_event` directly** → `insufficient_role`. Confirm
      this holds even for an event the Pro created themselves — Phase 30C1
      is Admin-only with no exception for creator-Pros.
- [ ] **Member calls `update_event` directly** → `insufficient_role`.
- [ ] **Null/invalid role** (defensive — a caller with no resolvable active
      membership) → `not_authenticated` (via `current_user_club_id()`
      returning null) rather than silently passing the `insufficient_role`
      check.
- [ ] **Wrong-club event ID** (valid ID, different club) → `event_not_found`.
- [ ] **Unknown event ID** → `event_not_found`.
- [ ] **Stale `p_expected_club_id`** → `stale_club_context`.
- [ ] **`status = 'cancelled'` event** → `event_cancelled`.
- [ ] **Archived event** (`archived_at` set) → `event_archived`.
- [ ] **Already-started event** (`starts_at <= now()`) → `event_started`.
- [ ] **Past event** (`starts_at` well in the past, regardless of status) →
      `event_started` (same rule, no separate "past" code).

## 2. Stale-edit conflict

- [ ] **Stale `p_expected_updated_at`** (does not match the event's current
      `updated_at`, e.g. after a concurrent edit) → `stale_edit_conflict`,
      and confirm the event row is completely unchanged afterward.

## 3. No-op behavior

- [ ] **True no-op** — every parameter resubmitted identical to the event's
      current values (including the exact current court set) → RPC returns
      successfully with `changed_fields: []` and `notifications: []`;
      confirm via direct query that `events.updated_at` is unchanged, no new
      `audit_log` row exists, no new `reservations` row was inserted or
      cancelled, and no new `notifications` row exists.

## 4. Standalone-event field editing

- [ ] Edit `title` only — succeeds; `changed_fields = ['title']`.
- [ ] Edit `event_type_id` to another active, same-club type — succeeds;
      the existing `events_check_event_type_active` trigger is exercised
      automatically (no separate check needed in the RPC).
- [ ] Edit `event_type_id` to an **inactive** type → `inactive_event_type`
      (from the trigger).
- [ ] Edit `event_type_id` to a type from a **different club** →
      `inactive_event_type` (the trigger's club-scoping catches this the
      same way).
- [ ] Edit `description` only — succeeds; `changed_fields = ['description']`;
      confirm §9's no-notification rule for this case.
- [ ] Edit every standalone field at once (title, type, date/time, courts,
      capacity, description) in one call — succeeds; `changed_fields`
      contains all of them.

### 4a. Event-type trigger avoidance for unrelated edits

- [ ] **Deactivate an event's existing `event_type_id`** (via the normal
      admin event-type management flow, or directly in staging), then edit
      that event's `capacity` (or title, date/time, court, or description)
      **without** changing `p_event_type_id` — succeeds. This is the case
      that would have incorrectly failed with `inactive_event_type` before
      this correction, since the `events_check_event_type_active` trigger
      fires whenever `event_type_id` merely appears in the `UPDATE`'s `SET`
      list, regardless of whether its value actually changed.
- [ ] Same setup, but this time **also** change `p_event_type_id` to a
      **different, active, same-club** type in the same call — succeeds;
      the new type takes effect.
- [ ] Same setup, but change `p_event_type_id` to the **same still-inactive**
      type it already has (i.e. `p_event_type_id` unchanged from
      `v_before.event_type_id`) while editing an unrelated field — succeeds
      (trigger not fired, since the column isn't in the `SET` list — the
      value is unchanged either way).
- [ ] Explicitly change `p_event_type_id` to a **different but inactive**
      type → `inactive_event_type` (trigger correctly fires and rejects,
      since the column genuinely is in the `SET` list this time).
- [ ] Explicitly change `p_event_type_id` to a type from a **different
      club** → `inactive_event_type` (unchanged from §4's existing case,
      confirming the branch split didn't affect this path).
- [ ] **Program session**: confirm `event_type_id` is never in either
      branch's `SET` list for a program-linked event (a program session's
      `p_event_type_id` is always forced equal to its current value by the
      §5 restriction guard before either branch runs), so the trigger is
      never fired by a program-session edit regardless of which branch
      executes.

## 5. Program-session field restrictions

- [ ] **Program session**: submit an unchanged `p_title`/`p_event_type_id`/
      `p_description` (matching the session's current values) while
      changing `starts_at` — succeeds normally, no restriction error (this
      is the legitimate UI path — the form always resubmits these three
      fields unchanged for a program session).
- [ ] **Program session**: submit a *different* `p_title` than the session's
      current value → `program_session_field_not_editable`, and confirm no
      partial mutation occurred (no reservation change, no event UPDATE, no
      audit row).
- [ ] **Program session**: submit a different `p_event_type_id` →
      `program_session_field_not_editable`.
- [ ] **Program session**: submit a different `p_description` →
      `program_session_field_not_editable`.
- [ ] **Standalone event** (program_id is null): confirm the restriction
      guard never fires regardless of what title/type/description values
      are submitted.

## 6. `is_program_exception` behavior

- [ ] Edit an eligible program-generated session (`is_program_exception`
      currently `false`) changing only `starts_at` — succeeds;
      `is_program_exception` becomes `true`; audit metadata's
      `is_program_exception_set` is `true`.
- [ ] Edit a program session that is **already** an exception
      (`is_program_exception = true` from a prior edit) — succeeds;
      `is_program_exception` remains `true`; audit metadata's
      `is_program_exception_set` is `false` (no transition occurred, since
      it was already true).
- [ ] Edit a standalone event — `is_program_exception` remains `false`
      throughout (it always was, and the `CASE` expression only ever flips
      it when `program_id is not null`).

## 7. `program_occurrence_date` preservation

- [ ] Edit a program session's `starts_at` to a **different calendar date**
      — succeeds; directly query the row afterward and confirm
      `program_occurrence_date` is **unchanged**, still equal to the
      session's original generated slot date, even though `starts_at` now
      falls on a different date. `program_id` and `program_schedule_rule_id`
      are also unchanged.
- [ ] Confirm no `UPDATE ... SET program_occurrence_date` (or the other two
      linkage columns) appears anywhere in `update_event`'s body (static
      check of the migration file — these three columns must never appear
      in the `events` `SET` list).

## 8. Court-set diff — retained / removed / added

- [ ] **Retained courts only, time unchanged** (edit only `capacity` or
      `description`) — confirm the event's linked `reservations` rows are
      **completely untouched**: same row `id`s, same `updated_at`, same
      `notes`.
- [ ] **Retained courts, time changed** — confirm the *same* reservation row
      `id`s persist (not cancelled-and-reinserted), with `starts_at`/
      `ends_at` updated to the new values and `notes` unchanged.
- [ ] **One court removed, others retained** — confirm the removed court's
      reservation row is soft-cancelled (`status='cancelled'`,
      `cancellation_kind='system'`, `cancelled_by`/`cancelled_at` set) and
      still exists in the table (not hard-deleted); confirm the retained
      courts' rows are unaffected by the removal.
- [ ] **One court added, others retained** — confirm a new `reservations`
      row is inserted for the added court (`reason='event'`,
      `status='confirmed'`) and the retained courts' rows are unaffected.
- [ ] **Simultaneous retain + remove + add** (e.g. 3 courts → 2 of the
      original 3 plus 1 new) — confirm each of the three groups is handled
      correctly in one call: retained rows preserved/time-updated as
      applicable, removed row soft-cancelled, added row inserted.
- [ ] **`events.court_count`** matches `array_length(p_court_ids, 1)` after
      every case above.

### 8a. Reservation-ownership preservation on added courts

- [ ] **Admin B edits an event created by Admin A** (`events.created_by` =
      Admin A's id), adding a new court — confirm the newly inserted
      `reservations` row for that court has `owner_user_id = created_by =`
      Admin A's id, **not** Admin B's.
- [ ] Same setup, and confirm every **retained** court's existing
      reservation row still shows `owner_user_id = created_by =` Admin A's
      id, unchanged (this RPC never touches those columns on a retained
      row at all).
- [ ] Confirm `audit_log`'s `actor_id` for this `update_event` call is
      Admin B (the editor), correctly distinguishing "who performed the
      edit" from "who owns the underlying court bookings."
- [ ] For a **removed** court in the same scenario, confirm the
      soft-cancelled row's `cancelled_by` is Admin B (the editor performing
      the cancellation-as-part-of-edit) while its `owner_user_id`/
      `created_by` remain Admin A's id, unchanged — `cancelled_by` records
      who cancelled it, not who owned it.
- [ ] Repeat with an event created by a **Pro** and edited by an **Admin** —
      same assertions: added/retained rows stay owned by the Pro; `actor_id`
      records the editing Admin.

## 9. Complete court-set replacement

- [ ] Replace **every** court (e.g. event was on Court A, edited to Court
      B only) — confirm Court A's reservation is soft-cancelled and Court
      B's is freshly inserted; confirm the new Court B row's `notes` equals
      the canonical pre-edit note derived from Court A's row (§10) — **not
      null merely because no court was retained**.

## 10. Notes preservation

- [ ] **Existing single-court event has non-null notes**; add a second
      court — confirm the new court's reservation row's `notes` exactly
      matches the original (retained) court's `notes` value.
- [ ] **Existing multi-court event, all rows share the same non-null
      notes**; add a court — confirm the new row inherits that value.
- [ ] **Existing multi-court event where rows have mixed null/non-null
      notes** (if reachable — note today's `create_event` always applies
      one uniform value to every court at creation, so this state would
      only arise from manual data manipulation in staging) — confirm the
      canonical-note query deterministically picks the same non-null value
      every time it's re-run (same court_id tiebreak), never varies between
      calls.
- [ ] **Every existing active row has null notes**; add a court — confirm
      the new row's `notes` is `null` (not an empty string, not inherited
      from anywhere else).
- [ ] **Full court-set replacement with non-null original notes** — confirm
      §9's assertion again explicitly: the brand-new court's row still
      inherits the canonical pre-edit note even though zero rows are
      retained.

## 11. GiST conflict / rollback behavior

- [ ] Edit a retained court's time into a slot already occupied by an
      unrelated reservation/event/maintenance block on that same court →
      Postgres `23P01`; confirm the **entire** call rolled back — the
      event's own row unchanged, no reservation soft-cancelled or inserted,
      no audit row, no notification.
- [ ] Edit to add a court whose new time conflicts with an unrelated booking
      on that court → `23P01`, same full-rollback confirmation.
- [ ] Edit multiple courts at once where only one of them has a genuine
      conflict → `23P01`, confirm **none** of the other courts' otherwise-
      valid changes were partially applied (all-or-nothing).

## 12. Capacity floor

- [ ] Attempt to reduce `capacity` below the current count of
      `confirmed` + `offered` participants (`role='participant'`) plus
      `event_guests` → `capacity_below_participants`; confirm no mutation
      occurred.
- [ ] Reduce capacity to a value still **at or above** the occupied count —
      succeeds.
- [ ] Confirm **waitlisted** participants are never counted toward the
      floor — reducing capacity below the *total* roster (confirmed+
      waitlisted) but still at/above the confirmed+offered+guest count must
      succeed.
- [ ] Confirm no participant, guest, offer, attendance record, or program-
      enrollment row is ever modified by any capacity edit, success or
      failure.

## 13. Capacity increase and sequential waitlist offer

- [ ] Event is full with a non-empty waitlist and **no** active offer;
      increase capacity by 1 — confirm exactly one waitlisted participant
      (FIFO per the existing `advance_waitlist_offer` ordering) transitions
      to `offered` with a fresh `offer_expires_at`, and a `waitlist_offer`
      notification is created for them (existing, unchanged mechanism).
- [ ] Event already has a **non-expired active offer** outstanding when
      capacity increases — confirm `advance_waitlist_offer`'s existing
      idempotency holds: **no second** competing offer is created; the
      existing offer is untouched.
- [ ] Event has a **stale (expired) offer** and a waitlist when capacity
      increases — confirm `expire_stale_offers_for_event` clears the stale
      offer first, then exactly one new offer is created for the next
      waitlisted participant.
- [ ] Capacity **decreased or unchanged** — confirm neither
      `expire_stale_offers_for_event` nor `advance_waitlist_offer` is
      invoked (no incidental offer churn from an edit that didn't free
      capacity).

## 14. Material notification creation

- [ ] Edit `title` only (no other change) — one `event_updated` notification
      per `confirmed`/`waitlisted`/`offered` participant; zero for anyone
      with a `cancelled` participant row; zero for guests.
- [ ] Edit `event_type_id` only — same recipient set notified.
- [ ] Edit `starts_at`/`ends_at` only — same.
- [ ] Edit the court set only (no time/capacity/title/type change) — same.
- [ ] Edit `capacity` only — same.
- [ ] Edit two or more material fields at once — **exactly one**
      notification per recipient (not one per changed field).
- [ ] Confirm the in-app row is inserted **unconditionally** — repeat any
      material-change case with the recipient's `event_updated`
      `notification_preferences` row set to `enabled=false` beforehand —
      the in-app `notifications` row must still be created (never suppressed
      by preference; only downstream email delivery may be suppressed, per
      the existing `sendEmailNotification`/`user_pref_enabled` mechanism —
      out of scope to re-verify here since it's unchanged infrastructure).

## 15. Description-only change — no notification

- [ ] Edit `description` only — confirm the `audit_log` row is written
      normally (§ audit assertions below) but **zero** `notifications` rows
      are created for any participant.

## 16. Exact `notification_id`/`user_id` return pairs

- [ ] For a material edit with 3 recipients (e.g. 1 confirmed, 1
      waitlisted, 1 offered), confirm the RPC's returned
      `notifications` array contains exactly 3 objects, each with a
      `notification_id` that corresponds to a real, freshly-inserted
      `notifications` row and a `user_id` matching that row's `user_id` —
      cross-check every pair against the `notifications` table directly (no
      bare/unassociated ID list).
- [ ] For a non-material (description-only) or no-op edit, confirm
      `notifications` is `[]`.

## 17. Audit-log assertions

- [ ] For any successful, non-no-op edit, confirm exactly one new
      `audit_log` row: `action='update_event'`, `target_type='event'`,
      `target_id=<event id>`, and `metadata` contains `changed_fields`,
      structured `before`/`after` objects (title/event_type_id/starts_at/
      ends_at/capacity/description), `program_id`, `is_program_exception_set`
      (boolean), `old_court_ids`, and `new_court_ids`.
- [ ] For a standalone event, confirm `program_id` in the audit metadata is
      `null`.
- [ ] For a court-set change, confirm `old_court_ids`/`new_court_ids` in the
      metadata exactly match the pre- and post-edit court sets.

## 18. `cancel_event` Pro-ownership regression fix

- [ ] **Pro cancels an event they created** (no host participant row
      exists, matching current real-world state since `create_event` has
      not inserted one since migration 0058) — succeeds. This is the case
      that was broken before this correction.
- [ ] **Pro attempts to cancel an event created by a different Pro or by an
      Admin** → `insufficient_role` (unchanged — ownership-scoped, not
      expanded).
- [ ] **Pro attempts to cancel an event where a stale host participant row
      happens to exist** (legacy data, if reachable in staging) — succeeds
      via `created_by`, confirming the fix no longer depends on the host row
      at all either way.
- [ ] **Member calls `cancel_event`** → `insufficient_role` (unchanged).
- [ ] **Active Pro cancels their own event** — succeeds (restated explicitly
      from the case above as the primary positive case this fix restores).
- [ ] **Pro is denied for another creator's event** — restated explicitly:
      a Pro whose `auth.uid()` does **not** match `events.created_by` for
      the target event → `insufficient_role`, regardless of the target
      event's actual creator role (Admin- or Pro-created, doesn't matter).
- [ ] **Former-Pro-now-Member is denied even when `created_by` matches** —
      the critical null-safe case: create an event as a Pro (so
      `events.created_by` = that user's id), then change that same user's
      role to Member (e.g. via `set_member_role`), then attempt
      `cancel_event` on that same event as that now-Member user →
      `insufficient_role`. This must fail even though `events.created_by`
      still equals their `auth.uid()` — confirms the role check rejects
      Member in its own guard *before* `created_by` is ever consulted, so a
      historical `created_by` match can never substitute for a
      no-longer-current Pro role.
- [ ] **Admin behavior is completely unchanged** by this correction —
      re-run every Admin-path case from §19 below and confirm identical
      results to a pre-correction baseline (Admin was never affected by
      either the original bug or this fix, since the ownership branch is
      only ever reached when `role <> 'admin'`).

## 19. Admin cancellation behavior remains unchanged

- [ ] **Admin cancels any event in their club**, including one they didn't
      create — succeeds, exactly as before this migration.
- [ ] **Admin cancels an already-archived event** → `event_archived`
      (unchanged guard, unrelated to the ownership-check fix).
- [ ] **Admin cancels an unknown/wrong-club event** → `event_not_found`
      (unchanged).
- [ ] For any successful Admin or Pro cancellation, confirm every other
      previously-existing behavior is unchanged: linked `reservations`
      rows cancelled (`cancellation_kind='admin'`, preserved from the
      current body — this cancellation-kind value itself is intentionally
      unchanged by this fix), `offered` participant rows cancelled and
      `offer_expires_at` cleared, one `audit_log` row
      (`action='cancel_event'`), and one `event_cancelled` notification per
      `confirmed`/`waitlisted`/`offered` participant (mandatory, unaffected
      by this checkpoint).

## 20. Operating-hours / closed-date parity (documented, not tested as a bug)

- [ ] **Confirm, not fix**: edit a standalone or program-session event's
      time into a slot outside the club's weekly `operating_hours` or on a
      closed-date `operating_hours_override` — the edit **succeeds**
      (no `outside_operating_hours`/`club_closed_this_day` error), exactly
      matching `create_event`'s current, pre-existing behavior. This is a
      deliberate parity decision, not an oversight: `create_event` has never
      validated operating hours or closed dates (confirmed by inspecting
      every historical redefinition), and `update_event` must not become
      stricter than creation without being explicitly asked to. This
      pre-existing product gap is out of scope for Phase 30C1 to close.
