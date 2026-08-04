# Phase 30G — Calendar Lesson-Management Entry Point — QA

Scope: `src/app/(app)/calendar/CalendarShell.tsx` (clickable eligible
`pro_lesson` blocks, resolving and navigating to the lesson-management
surface) and `src/app/(app)/events/LessonsTab.tsx` (the `?lessonId=` deep
link that auto-opens the exact request in the existing `LessonProSheet`).

No migration. No new RPC. No new form — this checkpoint only adds a click
path into the lesson-management surface that Phase 30E already built.
`propose_lesson_time`, `accept_lesson_proposal`, `decline_lesson_proposal`,
`cancel_lesson`, and migrations `0097`–`0101` are unmodified.

Run every case below against a non-production/staging Supabase project with
migrations `0097`–`0101` applied.

---

## 1. Identity resolution

- [ ] For a future confirmed `pro_lesson` reservation, confirm
      `handleManageLesson`'s query (`lesson_requests` where
      `linked_reservation_id = <reservation id>` and `club_id = <clubId>`
      and `status in ('confirmed','proposed')`) returns **exactly** the one
      request that RPC-accepted this reservation — never a different
      request that merely shares the same date/time/court/notes.
- [ ] Confirm identity is resolved **only** through
      `linked_reservation_id` — construct two lessons for the same
      member/pro/court on different days with similar notes and confirm
      clicking each Calendar block opens only its own exact request.

## 2. Authorization and eligibility

- [ ] **Admin** clicks any eligible same-club future `pro_lesson` block —
      the block is clickable and navigates correctly.
- [ ] **Assigned Pro** clicks their own eligible future `pro_lesson` block
      (`reservation.owner_user_id === auth.uid()`) — clickable, navigates
      correctly.
- [ ] **A different Pro** (not the reservation's owner) — the block is
      **not** clickable (`pointer-events-none`, no `role="button"`); no
      network request fires on click/tap.
- [ ] **Member** — the block is never clickable, exactly as before this
      checkpoint (privacy label "Private Lesson" still applies).
- [ ] **Confirmed lesson, no pending reschedule** — eligible, opens
      `LessonProSheet` showing "Propose New Time" and "Cancel Lesson".
- [ ] **Pending-reschedule lesson** (the original reservation is what's
      rendered and clicked; its linked request is `status='proposed'` with
      `linked_reservation_id` still set) — eligible, opens `LessonProSheet`
      showing "Revise Proposed Time" and "Cancel Lesson" — the sheet's
      existing Phase 30E behavior, not a new form.
- [ ] **Already-started or past lesson** — block is not clickable
      (`new Date(res.starts_at) > new Date()` fails the client-side gate).
- [ ] **Cancelled reservation** (`status <> 'confirmed'`) — not clickable.

## 3. Manually constructed `lessonId` URL

- [ ] **Member** navigates directly to
      `/events?tab=lessons&lessonId=<any request id>` — the Manage tab
      (and Lessons sub-tab) is not rendered for a Member at all
      (`isAdminOrPro` gates it server-side in `events/page.tsx`); no
      request data or sheet is ever reached.
- [ ] **Unrelated Pro** (not assigned to the target request) navigates to
      `/events?tab=lessons&lessonId=<someone else's request id>` — their
      own `initialRequests`/`requests` array (from
      `get_pro_lesson_requests`, which the RPC itself scopes to
      `pro_id = auth.uid()` for a pro caller) never contains that row, so
      `requests.find(...)` returns `undefined` and the sheet never opens —
      confirm no separate/unscoped query is made to fetch it another way.
- [ ] **Assigned Pro or Admin** navigates directly to a valid `lessonId` for
      a future confirmed lesson — opens correctly, same as the Calendar
      click-through path.
- [ ] **Stale/cancelled/declined/withdrawn `lessonId`** — present in
      `requests` (visible in the list) but fails the
      `status === 'confirmed' || (status === 'proposed' && linked_reservation_id)`
      check — `lessonId` is stripped from the URL and the sheet does not
      auto-open.
- [ ] **Nonexistent `lessonId`** — no match in `requests`; `lessonId` is
      stripped from the URL; no error, no crash, sheet simply doesn't open;
      the Lessons list renders normally.
- [ ] **Manually constructed `lessonId` for a past confirmed lesson** — the
      request's `status` is `'confirmed'` (passes the status-only check),
      but its linked reservation's `starts_at` is in the past — the
      reservation-level `starts_at > now()` check fails, `lessonId` is
      stripped, and the sheet does **not** auto-open.
- [ ] **Manually constructed `lessonId` for an already-started confirmed
      lesson** — same as above for a reservation whose `starts_at` has just
      passed (started but not yet ended) — still rejected; "future" means
      strictly `starts_at > now()`, not "hasn't ended yet."
- [ ] **Pending reschedule where the original linked reservation has
      started, even though the proposed candidate is still future** —
      construct a request with `status='proposed'`, `linked_reservation_id`
      set, and `proposed_starts_at` in the future, but where the **linked
      reservation's own** `starts_at` is in the past or already started.
      Confirm the sheet does **not** auto-open — this is the exact case the
      correction targets: `proposed_starts_at` is the new candidate, not
      the original lesson's authoritative time, and must never be used for
      this eligibility check.
- [ ] **Cancelled linked reservation** — the `lesson_requests` row still
      has `linked_reservation_id` set, but the referenced `reservations`
      row now has `status='cancelled'` (e.g. after `cancel_lesson`) — the
      reservation-level `status = 'confirmed'` check fails; sheet does not
      auto-open; `lessonId` is stripped.
- [ ] **Missing linked reservation** (defensive — `linked_reservation_id`
      references a row that no longer resolves, e.g. `maybeSingle()`
      returns `null`) — treated as ineligible; sheet does not auto-open;
      `lessonId` is stripped; no crash.
- [ ] **Wrong-club linked reservation** (defensive — should not be
      reachable given RLS and how `linked_reservation_id` is set, but
      verify anyway) — the explicit `reservation.club_id === clubId` check
      independently rejects it even if the row were somehow readable.
- [ ] **Valid future confirmed lesson still opens** — a request with
      `status='confirmed'` whose linked reservation is `reason='pro_lesson'`,
      `status='confirmed'`, same club, and `starts_at` in the future —
      opens `LessonProSheet` exactly as before this correction.
- [ ] **Valid future pending reschedule still opens** — a request with
      `status='proposed'`, `linked_reservation_id` set, whose linked
      reservation is still `confirmed`/same-club/future (only the
      `lesson_requests.proposed_starts_at` candidate is in flux, not the
      reservation itself) — opens `LessonProSheet` showing "Revise Proposed
      Time"/"Cancel Lesson" exactly as before this correction.

## 4. Close and browser-back behavior

- [ ] After the sheet auto-opens via `lessonId`, closing it strips
      `lessonId` from the URL (`router.replace`, no new history entry)
      while preserving `?tab=lessons` and any other existing query params.
- [ ] After closing, reloading the page does **not** re-open the sheet
      (param is gone).
- [ ] Pressing **browser back** immediately after arriving via the Calendar
      click returns to Calendar (the deep-link navigation itself is a
      `router.push`, so it's a real history entry) — not to an
      intermediate "sheet closed" state.
- [ ] Clicking the **same** Calendar lesson block a second time (after
      having closed the sheet once) re-opens it correctly — confirms the
      one-shot auto-open ref is re-armed on close, not permanently spent.
- [ ] Closing the sheet still calls `router.refresh()` — a change made
      inside the sheet (e.g. a successful "Revise Proposed Time") is
      reflected in the list immediately after close.

## 5. No generic reservation-cancellation path

- [ ] Confirm `pro_lesson` reservations **never** reach
      `ReservationDetailSheet` — Calendar's `isLesson` branch returns its
      own `<div>` unconditionally before the `isClickable`/
      `setSelectedReservation` logic used by every other reservation type;
      this is unchanged by this checkpoint (the click handler added here
      calls `handleManageLesson`/`router.push`, never `setSelectedReservation`).
- [ ] Confirm there is no way, from Calendar, to reach a generic
      **Edit Booking**, **Cancel Booking**, or **Cancel Block** control for
      a `reason='pro_lesson'` reservation.
- [ ] **Cancel Lesson** (from the opened `LessonProSheet`, either via the
      Calendar entry point or the existing in-page flow) still calls
      `cancel_lesson` exclusively — confirm via `audit_log`
      (`action='cancel_lesson'`) that no `admin_cancel_reservation` or
      `cancel_member_reservation` row was created for this reservation.
- [ ] Confirm `lesson_requests.status` and the reservation's own `status`
      stay consistent after a Calendar-entry-point cancellation (both move
      together, exactly as the existing `cancel_lesson` RPC already
      guarantees — unmodified by this checkpoint).

## 6. Mobile `LessonProSheet` behavior

- [ ] Tapping an eligible lesson block on a mobile viewport navigates and
      opens `LessonProSheet` with its existing mobile-draggable behavior
      unchanged (this checkpoint does not touch `LessonProSheet.tsx`
      itself).
- [ ] Touch target size for the clickable lesson block is reasonable at
      typical Calendar zoom levels (unchanged sizing from the existing
      block rendering — only its interactivity changed).
- [ ] Keyboard/focus: an eligible block is reachable via `Tab`
      (`tabIndex={0}`, `role="button"`) and activates on `Enter`/`Space`.

## 7. Regression — ordinary reservations, events, maintenance unaffected

- [ ] `member_booking` reservation blocks — click behavior, styling, and
      `ReservationDetailSheet` integration completely unchanged.
- [ ] `maintenance`/`admin_block` reservation blocks — click behavior and
      `EditMaintenanceSheet` integration completely unchanged.
- [ ] Event blocks and `EventDetailSheet` (including the Phase 30F Cancel
      Event button restyle) — completely unchanged.
- [ ] `propose_lesson_time`, `accept_lesson_proposal`,
      `decline_lesson_proposal`, `cancel_lesson`, and migrations
      `0097`–`0101` — unmodified; every Phase 30B–30E QA case for these
      RPCs still passes unchanged.
