# Phase 30B1 — Admin Reservation Editing and RPC-Backed Owner Cancellation — QA

Scope: `update_member_reservation` and `cancel_member_reservation` (migration
`0097_reservation_edit_foundation.sql`), the admin reservation-edit UI
(`ReservationDetailSheet` + new `EditReservationSheet`), and the
consolidation of member/pro cancellation onto RPCs in both
`src/app/(app)/calendar/actions.ts` and `src/app/(app)/my-schedule/page.tsx`.

This is Phase 30B1 only — `reservations_cancel_own` is **intentionally left
in place** (not dropped) by this checkpoint. Its removal is a separate,
later checkpoint (Phase 30B2 / migration `0098`), gated on this
checkpoint's application having been deployed to production and passed a
bake period with zero remaining raw-update call sites (see §11 of the
implementation report). Do not run the §12-style "raw UPDATE is denied"
verification against `reservations_cancel_own` yet — it will still succeed
until 0098 is applied, by design.

Event, maintenance-block, lesson, and program editing are out of scope for
this checkpoint and are not covered here.

---

## 1. SQL / RPC verification — `update_member_reservation`

Run as an authenticated Postgres session (or via `supabase.rpc(...)` from a
throwaway script) impersonating each role below. All cases assume migration
`0097` has been applied to a non-production/staging Supabase project first.

- [ ] **Admin edit success** — admin edits court, start time, and duration
      (end time) on an eligible reservation in one call; row is updated in
      place (same `id`); `changed_fields` in the returned jsonb lists every
      field that actually changed.
- [ ] **RPC-level metadata capability, unchanged** — the RPC itself still
      accepts and applies `p_format`/`p_player_count`/`p_guest_names`/
      `p_notes` when a caller explicitly passes new values (this checkpoint
      only removed the UI controls for these fields — the RPC signature and
      behavior are unchanged and remain reachable outside the admin edit
      form, e.g. for future tooling or direct RPC calls).
- [ ] **Hidden-metadata preservation (scheduling-only edit)** — for a
      reservation that already has non-null `format`/`player_count`/
      `guest_names`/`notes`, call the RPC the way `EditReservationSheet` now
      does: change only `p_court_id`/`p_starts_at`/`p_ends_at`, resubmitting
      the row's *existing* `p_format`/`p_player_count`/`p_guest_names`/
      `p_notes` values unchanged — confirm all four columns are untouched
      after the edit (not cleared, not nulled, not overwritten), and confirm
      `changed_fields` lists only the scheduling fields that actually
      changed.
- [ ] **Member calls the RPC directly** → `insufficient_role`.
- [ ] **Pro calls the RPC directly** → `insufficient_role`.
- [ ] **Wrong-club reservation ID** (valid ID, different club) →
      `reservation_not_found`.
- [ ] **Unknown reservation ID** → `reservation_not_found`.
- [ ] **Stale `p_expected_club_id`** (does not match the caller's current
      active club) → `stale_club_context`.
- [ ] **Stale `p_expected_updated_at`** (does not match the row's current
      `updated_at`, e.g. after a concurrent edit) → `stale_edit_conflict`.
- [ ] **`reason = 'maintenance'` row** → `reservation_not_editable`.
- [ ] **`reason = 'event'` row** → `reservation_not_editable`.
- [ ] **`reason = 'pro_lesson'` row** → `reservation_not_editable`.
- [ ] **`status = 'cancelled'` row** → `reservation_not_editable`.
- [ ] **Reservation whose `starts_at` has already passed** →
      `cannot_edit_started_reservation`.
- [ ] **Proposed `p_starts_at` in the past** → `cannot_book_past`.
- [ ] **`p_ends_at <= p_starts_at`** → `invalid_duration`.
- [ ] **Inactive court** (`is_active = false`) → `invalid_court`.
- [ ] **Court from a different club** → `invalid_court`.
- [ ] **Duration not in {30, 60, 90, 120} minutes**, court/time changed →
      `invalid_duration`.
- [ ] **Date with a closed-day `operating_hours_override`**, court/time
      changed → `club_closed_this_day`.
- [ ] **Date with a special-hours override**, proposed time outside the
      override's `opens_at`/`closes_at` → `outside_operating_hours`; inside
      the override's hours → succeeds.
- [ ] **No override for the date**, proposed time outside weekly
      `operating_hours` → `outside_operating_hours`; inside → succeeds.
- [ ] **Court conflict** — proposed court/time overlaps another
      pending/confirmed reservation, event, or maintenance block on that
      court → Postgres `23P01`, no partial update.
- [ ] **Notes-only change** (court/start/end unchanged) — succeeds even when
      today's club hours would reject the *unchanged* time range (e.g. hours
      were tightened after the original booking) — confirms scheduling
      validation is skipped when nothing scheduling-related changed.
- [ ] **No-op submission** (every field resubmitted identical to current
      values) — RPC returns successfully with `changed_fields: []` and
      `notification_id: null`; confirm via `audit_log` and `notifications`
      that **no new row was written** in either table, and confirm
      `updated_at` on the reservation is unchanged.
- [ ] **Audit assertion** — for a successful edit, `audit_log` has exactly
      one new row: `action = 'update_member_reservation'`, `target_type =
      'reservation'`, `metadata` contains `owner_user_id`, `changed_fields`,
      and structured `before`/`after` objects for every editable column.
- [ ] **Notification assertion (material change)** — editing court and/or
      start/end inserts exactly one `notifications` row,
      `kind = 'reservation_rescheduled'`, `user_id` = the reservation's
      owner, body includes the new court name and club-local date/time.
- [ ] **Notification assertion (mandatory, not preference-gated)** — with
      the owner's `notification_preferences` row for
      `reservation_rescheduled` set to `enabled = false`, repeat the
      material-change edit — the in-app `notifications` row is still
      inserted (never suppressed); only email delivery should be
      suppressed (see §8 email/SMS checks below).
- [ ] **No notification for non-material changes** — editing only notes,
      format, player count, and/or guest names (court/start/end unchanged)
      → no `notifications` row is inserted, `notification_id: null` in the
      response.

## 2. SQL / RPC verification — `cancel_member_reservation`

- [ ] **Member owner cancels their own confirmed `member_booking`
      reservation**, outside the cancellation window — succeeds;
      `status = 'cancelled'`, `cancellation_kind = 'member'`,
      `cancelled_by` = the member.
- [ ] **Pro owner cancels their own confirmed `member_booking`
      reservation**, outside the cancellation window — succeeds, same
      assertions as above.
- [ ] **Admin calls this RPC** (including on their own booking) →
      `insufficient_role`. Confirm admin cancellation (self or others)
      instead succeeds via `admin_cancel_reservation`, unchanged.
- [ ] **Member attempts to cancel another member's reservation** →
      `reservation_not_found` (ownership is enforced in the row lookup, not
      surfaced as a separate authorization error).
- [ ] **`reason` other than `member_booking`** (owned by the caller, if
      reachable) → `reservation_not_editable`.
- [ ] **Already-cancelled reservation** → `reservation_not_editable`.
- [ ] **Inside the cancellation window, outside the grace period** →
      `cancellation_window_closed`.
- [ ] **Inside the cancellation window, but within the grace period**
      (reservation created within `cancellation_grace_minutes` of now) —
      succeeds.
- [ ] **Outside the cancellation window entirely** — succeeds regardless of
      grace period.
- [ ] **`cancellation_grace_minutes = 0`** for the club — grace path never
      applies; only the outside-window path can succeed inside the window.
- [ ] **No `club_settings` row exists for the club** (edge case — should not
      occur in practice, but exercise it directly if reachable in staging) —
      falls back to the documented 24h/5min defaults deterministically;
      inside the (defaulted) window and outside the (defaulted) grace period
      still correctly raises `cancellation_window_closed` rather than
      silently permitting the cancellation.
- [ ] **Audit assertion** — one new `audit_log` row,
      `action = 'cancel_member_reservation'`, `target_type = 'reservation'`,
      metadata includes `court_id`, `owner_user_id`, `starts_at`, `reason`.
- [ ] **Notification assertion, preserved semantics** — with the caller's
      `reservation_cancelled_by_member` preference enabled (default), one
      `notifications` row is inserted, same kind/body shape as before this
      checkpoint; with the preference disabled, no row is inserted and the
      RPC still returns successfully with `notification_id: null`.

## 3. Admin UI manual QA

- [ ] Open an eligible reservation (confirmed, `member_booking`, future) as
      admin — both **Edit** and **Cancel Booking** are visible.
- [ ] Open a reservation that has already started as admin — **Edit** is
      hidden; **Cancel Booking** still visible.
- [ ] Open an already-cancelled reservation as admin (if reachable in the
      UI) — **Edit** is hidden.
- [ ] Open a maintenance block as admin — **Edit** is hidden (maintenance
      editing is out of scope for this checkpoint); **Cancel Booking** still
      works unchanged.
- [ ] Member owner opens their own reservation — **Edit** never appears,
      only **Cancel Booking**, unchanged from before this checkpoint.
- [ ] Pro owner opens their own reservation — same as member: **Edit** never
      appears (admin-only in this release), only **Cancel Booking** — see §5
      below for the fact that Cancel Booking now actually appears/works for
      Pro too.
- [ ] Tap **Edit** — the edit sheet opens; confirm the form shows exactly
      four fields — **Court**, **Date**, **Start Time**, **Duration** — and
      each is pre-populated from the current reservation. Format, player
      count, guest names, and notes are not present anywhere in this form.
- [ ] Edit court only, save — calendar grid reflects the new court on
      refresh; reservation detail sheet closes.
- [ ] Edit date/time only, save — grid reflects the new slot.
- [ ] Edit duration only, save — grid reflects the new end time.
- [ ] For a reservation that has existing `format`/`player_count`/
      `guest_names`/`notes` values (set via another path, e.g. admin
      tooling or a direct RPC call), edit only court/date/time/duration and
      save — then confirm via the database (or an admin data view, if one
      exists) that those hidden columns are unchanged, not cleared.
- [ ] Attempt to save into a court/time slot already occupied — inline
      court-conflict error message, no navigation away from the form.
- [ ] Attempt to save with all fields unchanged — succeeds silently (no
      error), sheet closes, no spurious change on the grid.
- [ ] **Discard** (header button) and swipe-to-dismiss / Escape / backdrop
      tap on the edit sheet all abandon the edit without saving and without
      touching the underlying reservation.
- [ ] Confirm the two destructive/action labels are never both visible or
      ambiguous at once: the edit sheet never shows "Cancel Booking", and
      the detail sheet's "Cancel Booking" is unaffected by an in-progress
      edit.

## 4. Nested-sheet mechanics (`ReservationDetailSheet` → `EditReservationSheet`)

Mirrors the proven `EventDetailSheet` → `EventRosterSheet` pattern — verify
the same properties hold for this new pairing:

- [ ] Opening **Edit** suspends the parent detail sheet: it becomes
      non-interactive (`inert`), its own Escape/backdrop/drag are disabled
      while the edit sheet is open.
- [ ] Only one drag gesture is ever active at a time — dragging the edit
      sheet's handle never also drags the parent underneath it.
- [ ] Desktop `Escape` while the edit sheet is open closes only the edit
      sheet, not the parent detail sheet.
- [ ] Closing the edit sheet (Discard, swipe-dismiss, Escape, or backdrop
      tap) restores focus to the **Edit** button on the parent sheet.
- [ ] Saving successfully closes both the edit sheet and the parent detail
      sheet (returns to the calendar grid), and the grid refreshes.
- [ ] Body-scroll stays locked throughout — background page never becomes
      scrollable while either sheet is open, and scroll is correctly
      restored once both are closed.

## 5. Cancellation regression + Pro self-cancel coverage

- [ ] Member cancels their own booking from **Calendar** — unchanged
      behavior (window/grace rule enforced, success/failure messaging
      unchanged).
- [ ] Member cancels their own booking from **My Schedule** — unchanged
      behavior.
- [ ] **Pro cancels their own booking from Calendar** — previously blocked
      by a UI gate; confirm this now works (Cancel Booking button appears
      and functions for a Pro-owned reservation opened from the calendar
      grid).
- [ ] Pro cancels their own booking from **My Schedule** — unchanged
      behavior (this already worked before this checkpoint).
- [ ] Admin cancels any reservation from **Calendar** — unchanged.
- [ ] **Admin cancels their own booking from My Schedule** — confirm this
      now routes through `admin_cancel_reservation` (no window enforcement)
      rather than the previous inconsistent window-bypass branch; behavior
      should now match cancelling from Calendar exactly.
- [ ] Cancellation-window and grace-period messaging in the UI is unchanged
      from a user's perspective in every case above, even though the
      computation has moved server-side.

## 6. Multi-club stale-tab tests

For an admin/member/pro belonging to more than one club:

- [ ] Open two tabs on the same account; switch the active club in tab A;
      in tab B (still showing the old club's calendar), attempt to edit a
      reservation — fails with the "active club changed, reload" message
      (`stale_club_context`, surfaced via the existing `assertActiveClub`
      preflight and/or the RPC's own transactional check).
- [ ] Same test for cancellation (member/pro self-cancel and admin cancel)
      in tab B.

## 7. Optimistic-concurrency test (two browser sessions)

- [ ] Admin session A and admin session B both open the **Edit** sheet for
      the same reservation.
- [ ] Session A saves a change successfully.
- [ ] Session B (still holding the original `updated_at`) attempts to save
      any change — fails with the stale-edit-conflict banner (not a
      generic error), offers **Reload**.
- [ ] Tapping **Reload** in session B re-fetches the reservation and resets
      every form field to the latest values (including A's change),
      clearing the conflict banner; session B can now save successfully.
- [ ] Confirm session B's original (stale) edit was never applied — the
      reservation reflects only session A's change plus whatever session B
      submits after reloading.

## 8. Notification, email, and SMS checks

- [ ] Material edit (court/date/time changed) with the owner's
      `reservation_rescheduled` email preference **enabled** — email is
      sent (or, in an environment without `RESEND_API_KEY`, the delivery
      attempt is skipped per existing `sendEmailNotification` behavior —
      confirm no error is thrown either way).
- [ ] Same edit with the preference **disabled** — in-app notification
      still appears in the bell; email is *not* sent; a
      `notification_deliveries` row with `status = 'opted_out'`,
      `channel = 'email'` is recorded.
- [ ] SMS: owner with `sms_opt_in = true` and a phone number on file
      receives the reschedule SMS (or, without Twilio configured, the
      attempt fails gracefully per existing `sendSms` behavior).
- [ ] SMS: owner with `sms_opt_in = false` — no SMS attempt is made beyond
      recording an `opted_out` delivery row.
- [ ] SMS: owner with `sms_opt_in = true` but no phone on file — a
      `no_phone` delivery row is recorded, no crash.
- [ ] Delivery dispatch failures (e.g. simulate a Resend/Twilio error) never
      surface as an edit or cancellation failure to the admin/member — the
      edit/cancel itself must show as successful regardless.
- [ ] Member-cancellation email/SMS still fires correctly using the
      `notification_id` returned by `cancel_member_reservation` (not a
      "newest matching kind" re-query) — verified indirectly by confirming
      delivery still works correctly when two cancellations happen in quick
      succession for the same user (no cross-delivery of the wrong body).

## 9. Real-device mobile form checks

Run on a real iPhone (Safari) and at least one real Android device
(Chrome) — per the existing project convention, desktop responsive mode
does not reliably reproduce touch/dynamic-viewport/native-input behavior.

- [ ] Date input in the edit sheet does not trigger iOS auto-zoom on focus,
      and does not overflow its container on either platform.
- [ ] Court pills, the start-time `<select>`, and duration pills — the
      edit sheet's only four fields — all behave reliably with the
      on-screen keyboard open (the date input is the only field that can
      summon one) — the sheet's scroll region (not a second nested scroll
      container) is what scrolls to keep the focused field visible.
- [ ] The edit sheet's own drag-to-dismiss gesture works correctly and does
      not conflict with scrolling the form body.

## 10. TypeScript / build validation

- [ ] `pnpm tsc --noEmit` passes with no new errors.
- [ ] `pnpm build` completes successfully.
- [ ] No `git diff --check` whitespace errors introduced.

## 11. Deployment sequencing reminder

Confirmed by design in this checkpoint, re-verify at deploy time:

- [ ] Migration `0097` applies cleanly to production with the
      *currently-deployed* (pre-30B1) application still running against it
      — nothing existing breaks, since `reservations_cancel_own` is
      untouched and no existing function signature changed.
- [ ] Only after `0097` is applied and the Phase 30B1 application code is
      deployed: run the admin-edit, member-cancel, and pro-cancel smoke
      tests above directly in production.
- [ ] `reservations_cancel_own` remains in place after this checkpoint —
      do **not** run migration `0098` (the policy drop) until this
      checkpoint has been live in production through a full bake period and
      a `git grep` of the deployed commit confirms zero remaining
      `.from("reservations").update(...)` call sites (see the
      implementation report's raw-update source audit).
