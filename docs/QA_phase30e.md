# Phase 30E — Confirmed-Lesson Rescheduling — QA

Scope: `supabase/migrations/0101_lesson_reschedule_foundation.sql` — the
widened `propose_lesson_time`, `accept_lesson_proposal`,
`decline_lesson_proposal`, and `cancel_lesson`; the pending-reschedule
guards added to `withdraw_lesson_request`, `decline_lesson_request`, and
`reassign_lesson_provider`; and the private
`_lesson_check_member_availability` self-conflict exclusion — plus the
application layer (`src/app/(app)/lessons/actions.ts`,
`LessonsTab.tsx`, `LessonProSheet.tsx`, `LessonRequestDetail.tsx`).

Locked product workflow (Phase 30E audit): re-propose / re-confirm. Admin
(any same-club lesson) or the currently assigned Pro (their own lesson only)
may propose a revised **date, start time, and court** for an already-confirmed
lesson. **Duration is unchanged by this phase** — every proposal, original or
reschedule, must still match the request's existing `duration_minutes`
exactly (`duration_mismatch`, unchanged validation; no duration-editing UI
exists). The Member must explicitly accept. The original confirmed
reservation remains fully active and visible on Calendar until acceptance.

Out of scope, unchanged by this checkpoint: provider reassignment on an
**ordinary confirmed lesson** (`reassign_lesson_provider` still requires
`pending`/`proposed` for the reassignment itself — its only change in this
migration is rejecting the pending-reschedule sub-case, not adding
confirmed-lesson reassignment), recurring lesson series, payments, public
booking, event/maintenance/personal-reservation editing.

Run every case below against a non-production/staging Supabase project.
Migration `0101` must be applied there first.

---

## 1. Authorized actors

- [ ] **Admin proposes a reschedule** for a confirmed lesson belonging to
      any pro in their club — succeeds.
- [ ] **Assigned Pro proposes a reschedule** for their own confirmed lesson
      — succeeds.
- [ ] **A different Pro** (not assigned to this lesson) calls
      `propose_lesson_time` against it → `not_assigned_pro`.
- [ ] **Member** calls `propose_lesson_time` directly → `insufficient_role`.
- [ ] **Member** never sees a reschedule-initiating control in the UI —
      only Admin/assigned-Pro do (`LessonProSheet.tsx`).

## 2. Eligibility

- [ ] **Confirmed lesson** — `propose_lesson_time` succeeds (begins a
      reschedule).
- [ ] **Pending reschedule** (`status='proposed'`,
      `linked_reservation_id` not null) — a second `propose_lesson_time`
      call from Admin/assigned-Pro succeeds (revises the pending candidate
      again).
- [ ] **Ordinary first-time `pending`/`proposed` request**
      (`linked_reservation_id` null) — unchanged, succeeds exactly as
      before this migration.
- [ ] **`declined`/`withdrawn`/`cancelled` request** →
      `invalid_status_for_propose` (unchanged).

## 3. Already-started guard

- [ ] **Confirmed lesson whose current (linked-reservation) start time has
      already passed** — `propose_lesson_time` → `cannot_reschedule_started_lesson`,
      even though the *new* candidate time is in the future.
- [ ] Same guard applies when **revising an already-pending reschedule**:
      if the original linked reservation's start has passed while the
      proposal was pending, a further revision is rejected the same way.
- [ ] Confirm this check reads the **linked reservation's** `starts_at`,
      not `lesson_requests.proposed_starts_at` (which by then holds the
      in-flight candidate, not the original).

## 4. Optimistic concurrency

- [ ] **Stale `p_expected_updated_at`** (doesn't match the request's
      current `updated_at`) → `stale_edit_conflict`; confirm the row is
      completely unchanged afterward.
- [ ] Confirm this applies uniformly to all three eligible starting
      statuses (`pending`, `proposed`, `confirmed`), not only the reschedule
      case.

## 5. Original reservation stays active while a proposal is pending

- [ ] After a successful reschedule proposal (`status` now `'proposed'`),
      query the **linked reservation** directly — confirm it is still
      `status='confirmed'`, completely untouched (same `id`, same
      `starts_at`/`ends_at`/`court_id`).
- [ ] Confirm the original confirmed time is still visible/bookable-around
      on **Calendar** — no special pending-reschedule badge is expected
      (explicitly out of scope for 30E), but the block itself must render
      exactly as an ordinary confirmed pro-lesson reservation.

## 6. Self-conflict exclusion

- [ ] Propose a reschedule whose new time **overlaps the still-active
      original confirmed time** (e.g. extending the lesson by 15 minutes
      into territory the original reservation already occupies) — succeeds;
      confirm neither the inline court-conflict check, the pro-availability
      check, nor the member-availability check falsely reports a conflict
      against the lesson's own linked reservation/request.
- [ ] Confirm this exclusion is scoped to **exactly**
      `linked_reservation_id` (or, for the member-lesson-conflict check,
      the request's own row) — construct an **unrelated** reservation
      overlapping the new proposed time on the same court/pro/member and
      confirm it is **not** excluded and still correctly raises
      `court_conflict` / `pro_has_conflict` / `member_has_lesson_conflict`
      as appropriate.

## 7. Proposal-time vs. acceptance-time conflicts

- [ ] After a reschedule proposal is created, have an **unrelated** booking
      take the proposed slot (e.g. another admin books that court/time
      directly) before the member accepts — confirm the proposal itself is
      unaffected (no re-validation happens merely by the slot becoming
      occupied) and the member can still attempt to accept.
- [ ] **Acceptance conflict**: with the proposed slot now occupied by that
      unrelated booking, have the member call `accept_lesson_proposal` —
      confirm Postgres `23P01` is raised and the **entire** transaction
      rolls back: the old reservation remains `status='confirmed'`
      (not left cancelled), no new reservation is inserted, and
      `lesson_requests` is completely unchanged (`linked_reservation_id`
      still points at the old row, `status` still `'proposed'`).
- [ ] **Original lesson started before acceptance**: with a reschedule
      proposal pending, let the *original* linked reservation's start time
      pass (without cancelling or accepting), then have the member call
      `accept_lesson_proposal` → `cannot_reschedule_started_lesson`. This
      check runs **before** the old reservation's soft-cancel UPDATE —
      confirm the old reservation remains `status='confirmed'`, unchanged,
      and no new reservation is inserted.
- [ ] **Court deactivated before acceptance**: propose a reschedule to a
      specific court, then deactivate that court (`courts.is_active =
      false`) before the member accepts — `accept_lesson_proposal` →
      `court_not_found`; confirm the old reservation remains confirmed and
      no new reservation is inserted.
- [ ] Confirm the court-active revalidation applies to an **ordinary
      first-time acceptance** too (no prior confirmation) — deactivate the
      proposed court before accepting a first-time proposal → same
      `court_not_found`, matching the same guard.

## 8. Successful acceptance — replacement transaction

- [ ] Member accepts a reschedule proposal — confirm in one transaction:
      the **old** linked reservation becomes `status='cancelled'`,
      `cancellation_kind='system'`, `cancelled_by`=the member (the
      accepting actor), `cancelled_at` set; a **new** `reservations` row is
      inserted (`reason='pro_lesson'`, `status='confirmed'`,
      `owner_user_id`=the pro).
- [ ] Confirm `lesson_requests.linked_reservation_id` now points at the
      **new** reservation's id (not the old one).
- [ ] Confirm `confirmed_at` is updated to the acceptance time (matches
      existing accept behavior, unchanged).
- [ ] Confirm exactly **one** old row and **one** new row exist afterward —
      no duplicate active reservations for this lesson.
- [ ] **Ordinary first-time acceptance** (no prior confirmation,
      `linked_reservation_id` null beforehand) — unchanged: inserts one
      reservation, no cancel step attempted.

## 9. Audit and notification — propose/accept

- [ ] `propose_lesson_time` on a reschedule writes one `audit_log` row
      (`action='propose_lesson_time'`) with `metadata.is_reschedule = true`;
      an ordinary first-time proposal has `is_reschedule = false`.
- [ ] `accept_lesson_proposal` on a reschedule writes one `audit_log` row
      (`action='accept_lesson_proposal'`) with `metadata.old_reservation_id`
      set to the cancelled row's id, `metadata.new_reservation_id` set to
      the new row's id, and `metadata.is_reschedule = true`. An ordinary
      first-time acceptance has `old_reservation_id = null`,
      `is_reschedule = false`.
- [ ] Confirm the **Member** (only) receives a `lesson_request_proposed`
      notification when a reschedule is proposed — the Pro/Admin who
      proposed it does not receive one, matching existing propose behavior.
- [ ] Confirm both the **Member and the assigned Pro** receive a
      `lesson_request_confirmed` notification when the proposal is
      accepted — same existing notification kinds, reused (no new kind was
      added).

## 10. Decline restores the original confirmed lesson

- [ ] Member declines a reschedule proposal (`decline_lesson_proposal`) —
      confirm `lesson_requests.status` returns to `'confirmed'` (not
      `'pending'`), and `proposed_starts_at`/`proposed_ends_at`/
      `proposed_court_id` are restored to **exactly** the still-active
      linked reservation's `starts_at`/`ends_at`/`court_id`.
- [ ] Confirm `linked_reservation_id` is unchanged throughout, and the
      linked reservation itself was never modified at any point in this
      flow.
- [ ] Confirm the linked reservation is read with `FOR UPDATE` before the
      request is restored (row-locked for the duration of the decline, same
      as every other place this migration treats it as authoritative) —
      not independently observable via a single call, but confirm via
      `pg_locks`/concurrent-session testing that a simultaneous
      `cancel_lesson` or second `decline_lesson_proposal` call blocks until
      this one completes rather than racing it.
- [ ] **Ordinary first-time decline** (`linked_reservation_id` null) —
      unchanged: reverts to `'pending'`, nulls the proposed fields.
- [ ] Confirm the `audit_log` row for a reschedule decline includes
      `metadata.is_reschedule = true` and `metadata.restored_starts_at`
      matching the linked reservation's `starts_at`.
- [ ] Confirm no new notification is created on decline, matching today's
      existing (notification-less) decline behavior.

## 11. Cancellation while a reschedule is pending

- [ ] With a reschedule proposal pending (`status='proposed'`,
      `linked_reservation_id` set), Member/assigned-Pro/Admin calls
      `cancel_lesson` — succeeds (previously would have failed with
      `invalid_status_for_cancel` since status wasn't `'confirmed'`).
- [ ] Confirm the still-active **linked** reservation is cancelled
      (`cancellation_kind` mapped member→`'member'`, pro/admin→`'admin'`,
      matching existing logic), and `lesson_requests.status` becomes
      `'cancelled'`.
- [ ] Confirm the pending proposal's candidate fields are discarded as
      unresolved (request is now `'cancelled'`, not revisited).
- [ ] **Already-started guard during pending reschedule**: if the
      **original** linked reservation's start has already passed, a
      non-admin caller is rejected with `lesson_already_started` — confirm
      this reads the linked reservation's `starts_at`, not the in-flight
      proposed candidate.
- [ ] **Cancellation window during pending reschedule** (member actor):
      confirm the club's `cancellation_window_hours` is evaluated against
      the **original** linked reservation's `starts_at`, not the proposed
      candidate's time.
- [ ] **Ordinary first-time proposal** (`status='proposed'`,
      `linked_reservation_id` null) — `cancel_lesson` still rejects with
      `invalid_status_for_cancel`; confirm the widened path did **not**
      open cancellation for this case.
- [ ] **Ordinary confirmed lesson, no pending reschedule** — `cancel_lesson`
      behavior is completely unchanged from before this migration.

## 11a. Legacy lesson RPCs reject a pending reschedule

With a reschedule proposal pending (`status='proposed'`,
`linked_reservation_id` not null), each of the following must reject rather
than silently orphan the still-active original reservation. Each reuses its
function's own existing status-guard error code — no new code was
introduced.

- [ ] **`withdraw_lesson_request`** called by the member during a pending
      reschedule → `invalid_status_for_withdraw`; confirm the request and
      the linked reservation are both completely unchanged.
- [ ] **`decline_lesson_request`** called by the assigned Pro or Admin
      during a pending reschedule → `invalid_status_for_decline`; confirm
      both rows unchanged.
- [ ] **`reassign_lesson_provider`** called by Admin during a pending
      reschedule → `invalid_status_for_reassign`; confirm `pro_id`,
      `linked_reservation_id`, and the linked reservation's `owner_user_id`
      are all unchanged.
- [ ] **Ordinary first-time `pending`/`proposed` request**
      (`linked_reservation_id` null) — all three RPCs behave exactly as
      before this migration: `withdraw_lesson_request` and
      `decline_lesson_request` succeed on `pending`/`proposed`;
      `reassign_lesson_provider` succeeds on `pending`/`proposed`.
- [ ] **UI**: confirm `LessonProSheet.tsx`'s "Reassign Pro" button is hidden
      during a pending reschedule (Admin view) — previously visible for any
      `status='proposed'` row regardless of `linked_reservation_id`.
- [ ] **UI**: confirm the Member's "Withdraw Request" control (gated to
      `status === 'pending'` only) was never reachable during a pending
      reschedule in the first place — this UI guard predates this
      correction and needed no change, but the RPC-level guard above is
      still mandatory defense-in-depth.

## 12. Repeated revision of a pending reschedule

- [ ] Propose a reschedule, then (before the member responds) propose
      **again** with a different candidate time/court — succeeds; confirm
      `proposed_starts_at`/`ends_at`/`court_id` reflect only the latest
      candidate, `linked_reservation_id` is unchanged throughout, and the
      original reservation is still untouched.
- [ ] Confirm each revision writes its own `audit_log` row and its own
      `lesson_request_proposed` notification (no deduplication expected —
      matches existing propose behavior).
- [ ] Confirm a stale `p_expected_updated_at` on the **second** revision
      (using the value from before the first revision) correctly raises
      `stale_edit_conflict`.

## 13. Overload cleanup

- [ ] Confirm exactly **one** `propose_lesson_time` overload exists in the
      database afterward (`select proname, pg_get_function_identity_arguments(oid) from pg_proc where proname = 'propose_lesson_time'` returns one row) — the old 4-argument signature
      (`uuid, timestamptz, timestamptz, uuid`) must not remain callable.
- [ ] Attempt to call the **old** 4-arg signature directly (if reachable
      via a raw RPC call bypassing the generated client types) — confirm it
      fails (function does not exist), not that it silently succeeds
      without the concurrency/reschedule-eligibility checks.

---

## 14. UI — Pro/Admin (`LessonsTab.tsx` / `LessonProSheet.tsx`)

- [ ] **Pending request**: "Propose a Time" still renders exactly as
      before.
- [ ] **Confirmed lesson**, viewed by Admin or the assigned Pro: "Propose
      New Time" renders (list-card quick action and in the detail sheet's
      default action buttons).
- [ ] **Confirmed lesson**, viewed by a different Pro: no reschedule
      action renders.
- [ ] **Pending reschedule** (`status='proposed'` with
      `linked_reservation_id`), viewed by Admin or assigned Pro: "Revise
      Proposed Time" renders instead of "Propose New Time"; submitting
      revises the pending candidate.
- [ ] Confirm `request.updated_at` is passed into `proposeLessonTime` for
      every case (initial pending propose, confirmed reschedule, and
      reschedule revision) — verify by forcing a `stale_edit_conflict`
      (edit the row directly in SQL between opening the sheet and
      submitting) and confirming the friendly "This lesson was changed by
      someone else. Reload and try again." message appears.
- [ ] Force `cannot_reschedule_started_lesson` (attempt a reschedule after
      the original confirmed time has passed) — confirm the friendly "This
      lesson has already started and can no longer be rescheduled."
      message appears, not a raw error code.
- [ ] **Pro/Admin "Decline Request"** (whole-request decline): confirm it
      is **hidden** for a pending reschedule (`status='proposed'` with
      `linked_reservation_id` set) — only visible for an ordinary
      first-time `'proposed'` request. This prevents declining the whole
      request while a confirmed reservation is still silently attached and
      active.
- [ ] **Pro/Admin "Cancel Lesson"**: confirm it now also renders (and
      works) during a pending reschedule, in addition to the ordinary
      confirmed case.
- [ ] **Reassign Pro**: confirm it remains visible for an ordinary
      first-time `pending`/`proposed` request exactly as before, but is now
      **hidden** for a pending reschedule (`linked_reservation_id` set) —
      see §11a. Still unavailable for any ordinary confirmed lesson
      (reschedule-pending or not), unchanged.

## 15. UI — Member (`LessonRequestDetail.tsx`)

- [ ] **Pending reschedule** (`status='proposed'` with
      `linked_reservation_id`): the proposed-time card is labeled
      "Reschedule proposed by {pro}" (not "Time proposed by {pro}") and
      includes the explanatory line that the original confirmed lesson
      stays booked until the member responds.
- [ ] **Ordinary first-time proposal** (`linked_reservation_id` null): card
      label and copy are unchanged from before this migration ("Time
      proposed by {pro}", no extra explanatory line).
- [ ] **Accept**/**Decline** buttons are present and functional in both the
      ordinary-proposal and reschedule-proposal cases — same buttons, same
      handlers, unchanged from before this migration.
- [ ] After **declining** a reschedule, confirm the sheet (on next open, or
      via `router.refresh()`) shows the normal green "Confirmed lesson"
      card again, using the restored original time/court — visually
      indistinguishable from a lesson that was never rescheduled.
- [ ] **Member "Cancel Lesson"**: confirm it now also renders during a
      pending reschedule, in addition to the ordinary confirmed case, using
      the same existing confirmation flow.

## 16. Regression — event, maintenance, personal-reservation behavior unaffected

- [ ] Event editing (`EditEventSheet`/`update_event`, Phase 30C) —
      unaffected, no shared code path touched.
- [ ] Maintenance-block editing (`EditMaintenanceSheet`/
      `update_maintenance_block`, Phase 30D) — unaffected.
- [ ] Member personal court-booking edit/cancel
      (`EditReservationSheet`/`update_member_reservation`/
      `cancel_member_reservation`) — unaffected.
- [ ] `reassign_lesson_provider` — unaffected; confirmed lessons remain
      ineligible for reassignment, exactly as before this migration.
