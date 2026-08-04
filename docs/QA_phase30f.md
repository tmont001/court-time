# Phase 30F — Final Polish, Regression, and Closeout — QA

This is the closeout checkpoint for the whole Phase 30 arc (Admin editing
across reservations, events, maintenance blocks, and lesson rescheduling).
It does **not** repeat the detailed RPC/UI test matrices already recorded in
`QA_phase30b1.md`, `QA_phase30b2.md`, `QA_phase30c.md`, `QA_phase30d.md`, and
`QA_phase30e.md` — run those in full for their respective areas. This
document covers only: the Cancel Event button restyle, the Calendar
lesson-management investigation and its outcome, a focused final regression
pass across all four editing areas, and the deferred-item list for
post-Phase-30 work.

Migrations `0097`–`0101` are applied. Run everything below against a
non-production/staging Supabase project with those migrations in place.

---

## 1. Cancel Event alignment (`EventDetailSheet.tsx`)

- [ ] On an eligible event (Admin viewer, or the creator-Pro), **Cancel
      Event** now renders as a full-width red-tinted bordered button
      (matching Edit Event/Join Event's size and shape — `w-full py-3
      rounded-xl text-sm font-semibold`), not a small underlined text link.
- [ ] Tapping it shows the same inline "Cancel this event?" confirmation as
      before, now with **Keep** / **Yes, cancel** as an equal-width `flex-1`
      pair (mirrors this file's existing offer Accept/Pass button pattern).
- [ ] **Admin** can cancel any eligible event via this button — unchanged
      authorization (`canCancelEvent`, untouched).
- [ ] **Creator-Pro** can cancel their own event via this button — unchanged
      (`event.created_by === userId` check, untouched).
- [ ] A **non-creator Pro** and a **Member** still never see this button.
- [ ] `cancel_event` and its Server Action were not modified — cancellation
      still fails/succeeds for exactly the same cases as before this
      checkpoint (event already cancelled/archived, wrong club, etc.).
- [ ] Loading/disabled state: the "Yes, cancel" button still disables
      (`disabled={cancelLoading}`) during the request, showing "Cancelling…".
- [ ] Error display (e.g. a stale/already-cancelled event) still renders
      inline below the confirmation row.
- [ ] **Desktop**: button and confirmation row render correctly at sheet
      width, no overflow or misalignment against Edit Event above it.
- [ ] **Mobile**: full-width button and the Keep/Yes-cancel pair remain
      easily tappable (44px+ touch target via `py-3`), no layout shift when
      switching between the two states.

## 2. Calendar lesson-management — finding

**Reservation → lesson request identity is reliably resolvable without a
migration.** `reservations` has no `lesson_request_id` column, but
`lesson_requests.linked_reservation_id` points the other way, and at most
one `lesson_requests` row references a given still-active reservation at any
time (Phase 30E's replace-atomically design guarantees this — a reschedule's
acceptance retargets `linked_reservation_id` to the new row before the old
one is ever left dangling). A same-club reverse lookup —
`select id from lesson_requests where linked_reservation_id = <reservation.id> and club_id = <clubId> and status = 'confirmed'`
— is authorized today by the existing `lesson_requests_select_pro` /
`_select_admin` RLS policies (0069) with no new RPC or policy required.

## 3. Calendar integration — deferred

**Not implemented in Phase 30F.** Data identity is available, but the full
desired UX is not a narrow, isolated change once the actual integration
surface is inspected:

- `pro_lesson` reservation blocks in `CalendarShell.tsx` are currently
  rendered with `pointer-events-none` and never open `ReservationDetailSheet`
  at all — enabling that click path is itself a small change, but...
- `ReservationDetailSheet.tsx`'s existing **Cancel** button renders
  unconditionally for every reservation `reason` (it is not currently
  gated by `reason`, since no lesson reservation has ever reached this sheet
  before). Making lesson blocks clickable without also excluding this
  button for `reason === 'pro_lesson'` would let an Admin trigger
  `admin_cancel_reservation` directly against a lesson's reservation — which
  cancels only the `reservations` row and leaves the owning
  `lesson_requests` row `status='confirmed'`, pointing at a now-cancelled
  reservation. Lesson cancellation must go exclusively through
  `cancel_lesson` (Phase 30E), never the generic reservation-cancel path.
  This is a real correctness trap, not just a missing feature.
- Delivering "opens the existing lesson-management surface" as more than a
  generic tab link requires a new id-based deep-link mechanism in
  `LessonsTab.tsx`/`AdminLessonsWrapper.tsx` (auto-selecting a specific
  request on mount) that does not exist today — the only comparable
  precedent (`?q=` title search for Programs' "View Sessions") is a search
  prefill, not an exact-match auto-open, and would need to be extended
  carefully to avoid colliding with that existing param's own effect.

None of this requires a migration or a duplicated proposal form, and the
identity-resolution piece above is genuinely safe on its own — but wiring it
up correctly touches three files and introduces one new cross-page
navigation contract, which is more than the narrow change this checkpoint is
scoped for. **No code was changed for this item; Calendar's click behavior
for `pro_lesson` blocks is unchanged.**

**First post-Phase-30 UX enhancement (recorded, not scheduled):** make
`pro_lesson` Calendar blocks clickable for Admin/assigned-Pro, opening
`ReservationDetailSheet` with (a) the generic Cancel button excluded for
`reason === 'pro_lesson'` and (b) a "Manage Lesson" action that performs the
reverse lookup above and deep-links into `/events?tab=lessons` with a new
`?lessonId=` param that `LessonsTab.tsx` reads to auto-open that exact
request in `LessonProSheet`.

## 4. Phase 30 final regression pass

### Personal reservations

- [ ] Admin edits a future Member reservation via `EditReservationSheet` /
      `update_member_reservation` — succeeds, unchanged from Phase 30B1.
- [ ] Member and Pro owners still cancel their own personal bookings
      exclusively through `cancel_member_reservation` — configured
      cancellation-window and grace-period behavior intact.
- [ ] Confirmed: no `reservations` RLS UPDATE policy exists (`0098` dropped
      `reservations_cancel_own`; `0099`–`0101` add zero `create policy`
      statements) — grep of the migrations confirms this directly.
- [ ] Confirmed: no raw `.from("reservations").update(...)` client call
      exists anywhere in `src` — every mutation still goes through an RPC.

### Events

- [ ] Admin edits an eligible standalone event via `EditEventSheet` /
      `update_event` — succeeds.
- [ ] Admin edits an individual program session — succeeds;
      `is_program_exception` becomes `true` on first edit, unchanged.
- [ ] Creator-Pro cancels their own event via the (now full-width) Cancel
      Event button — succeeds; `canCancelEvent` still checks
      `event.created_by === userId`, unchanged by the §1 restyle.
- [ ] Pro event **editing** (not cancellation) remains unavailable — `canEdit`
      in both `EventDetailSheet.tsx` and `AdminEventsClient.tsx` is still
      `userRole === "admin"` only, no Pro exception.
- [ ] Member cannot open Edit or Cancel Event for any event.
- [ ] `update_event`'s notification dispatch still consumes the exact
      `{notification_id, user_id}` pairs returned by the RPC — never a
      "newest matching kind" re-query.

### Maintenance

- [ ] Admin edits one future maintenance block via `EditMaintenanceSheet` /
      `update_maintenance_block` — succeeds, always exactly the one
      reservation row clicked (no group identity, per the Phase 30D
      decision).
- [ ] Pro and Member never see Edit Block — `canEditMaintenance` in
      `ReservationDetailSheet.tsx` is still `isAdmin` only.
- [ ] A legacy multi-court creation (several independent rows sharing
      original timestamps/notes) — editing one row still leaves its
      siblings completely untouched.
- [ ] Cancel Block still works via the unchanged `admin_cancel_reservation`
      path.

### Lessons

- [ ] Admin or the assigned Pro proposes a new **date, start time, and
      court** for a future confirmed lesson — succeeds; **duration is
      unchanged** (`duration_mismatch` still enforced against the request's
      existing `duration_minutes`; no duration-editing control exists in
      either `LessonProSheet.tsx`'s `TimePicker` or the RPC signature).
- [ ] The original confirmed reservation remains `status='confirmed'` and
      visible on Calendar until the Member accepts.
- [ ] Acceptance atomically cancels the old reservation
      (`cancellation_kind='system'`) and inserts exactly one new one,
      updating `linked_reservation_id`.
- [ ] Decline restores `lesson_requests.status='confirmed'` with
      `proposed_starts_at`/`ends_at`/`court_id` copied back from the
      still-untouched linked reservation.
- [ ] Cancelling during a pending reschedule (`status='proposed'` with
      `linked_reservation_id` set) succeeds via `cancel_lesson`.
- [ ] A pending reschedule cannot be withdrawn (`withdraw_lesson_request`),
      whole-request-declined (`decline_lesson_request`), or reassigned
      (`reassign_lesson_provider`) — all three reject with their existing
      status-guard error code when `linked_reservation_id` is set.
- [ ] An ordinary first-time lesson request (`pending` → propose → accept,
      `linked_reservation_id` null throughout until first confirmation)
      still works exactly as it did before Phase 30E — withdraw, decline,
      and reassign all remain available for it.

## 5. Mobile nested-sheet checks (code-level, cross-cutting)

All four editing surfaces added this phase (`EditEventSheet`,
`EditMaintenanceSheet`, and the Phase 30E lesson-propose flow reusing
`LessonProSheet`'s existing form) follow the same established convention:
`ResponsiveSheet` with `mobileInteraction="draggable"`, elevated
`mobileBackdropZ={60}`/`mobilePanelZ={70}` when nested under a parent detail
sheet, and the parent suspended via `active={!childOpen}`. Confirm on an
actual mobile viewport (or device emulation):

- [ ] Opening Edit Event / Edit Block from their respective detail sheets
      correctly suspends the parent (no double-scroll, no stacked backdrop
      taps reaching the wrong sheet).
- [ ] Drag-to-dismiss on the child sheet never also dismisses the parent.
- [ ] Closing the child sheet without saving restores full interactivity to
      the parent (Escape/backdrop tap work again immediately).
- [ ] Date/duration/court inputs across all three new sheets use the
      mobile-safe `.ct-input`/`.ct-date-input` classes and `text-base
      md:text-sm` sizing (no iOS zoom-on-focus).

## 6. Migrations applied

- [ ] `0097_reservation_edit_foundation.sql`
- [ ] `0098_remove_reservation_direct_update_policy.sql`
- [ ] `0099_event_edit_foundation.sql`
- [ ] `0100_maintenance_edit_foundation.sql`
- [ ] `0101_lesson_reschedule_foundation.sql`

## 7. Deferred items (explicitly out of scope for Phase 30)

- **Creator-Pro event editing** — Pro may cancel an event they created, but
  editing (title/time/courts/capacity) remains Admin-only. No Pro exception
  was added anywhere in Phase 30C–30F.
- **Grouped maintenance-block editing** — no durable multi-court group
  identity exists or was added; each maintenance reservation row is edited
  independently, per the locked Phase 30D product decision.
- **Lesson duration changes** — confirmed-lesson rescheduling covers date,
  start time, and court only; `duration_minutes` is immutable through this
  entire feature.
- **Whole-program schedule editing** — Phase 30 never touched program
  recurrence-rule editing; only individual program-generated sessions are
  editable (via `update_event`'s existing `program_session_field_not_editable`
  restriction, unchanged).
- **Calendar → lesson-management deep link** — see §3 above.
