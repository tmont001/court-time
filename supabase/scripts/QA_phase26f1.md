# Phase 26F1 QA Checklist — Critical Stale-Club Mutation Protection

Covers Phase 26F1: `src/lib/staleClub.ts`, `src/lib/supabase/staleClub.ts`
(the `assertActiveClub` guard), and every mutation action listed in the
Phase 26F1 report under "Mutations protected." No SQL/migration is part of
this checkpoint — this is an application-layer guard only. No RLS/RPC
authorization changed; only a pre-write staleness check was added.

Requires a multi-club test account (an account with active memberships in
two clubs, Club A and Club B — reuse the Phase 26E1/26E2 disposable test
account if available) and a second, disposable single-club account for the
"current-club writes still succeed" and "existing one-club behavior"
scenarios.

**How to induce a stale club context for these tests:** open the app in two
tabs as the multi-club test account, both starting with Club A active. In
Tab 1, load a page with an open mutation surface (Calendar, Events, or
Lesson Requests) — do not reload it. In Tab 2, switch the active club to
Club B via the club switcher. Return to Tab 1 (still showing Club A's UI,
not reloaded) and submit the mutation. Tab 1's `expectedClubId` (Club A) no
longer matches the account's current active club (Club B) — this is the
stale-context condition. This deliberately keeps Tab 1 open past the point
where Phase 26E2's `StaleActiveClubGuard` would normally catch the switch
and show its blocking overlay on next focus/visibility check, isolating the
mutation-level guard from the tab-level one.

---

## 1. Stale reservation write blocked

- [ ] Induce staleness (see above) with Tab 1 on `/calendar`
- [ ] In Tab 1, attempt to book a court — confirm the booking is rejected
      with "Your active club changed. Reload this page and try again."
      and no reservation is created
- [ ] **[SQL]** Confirm no new row exists in `reservations` for Club A or
      Club B from this attempt
- [ ] Repeat for cancelling an existing Club A reservation from Tab 1 (both
      the member cancel path and, as an admin test account, the admin
      cancel path) — confirm the same error and that the reservation's
      `status`/`cancelled_at`/`cancelled_by` are unchanged
- [ ] Repeat once more via `/my-schedule` (the separate inline cancel
      action on that page) — confirm the reservation is not cancelled (this
      path shows no error message by design; confirm via SQL that the row
      is unchanged instead)

## 2. Stale event signup blocked

- [ ] Induce staleness with Tab 1 on `/events` (or `/calendar` /
      `/my-schedule`, all three call the same guarded actions)
- [ ] Attempt to join a Club A event from Tab 1 — confirm rejection with
      the stale-club message and no `event_participants` row is created
- [ ] Attempt to leave a Club A event the account is already signed up
      for — confirm rejection and the participant row is unchanged
- [ ] Attempt to accept and, separately, decline a waitlist offer — confirm
      both are rejected and the offer's status is unchanged
- [ ] As an admin/pro test account, attempt to cancel a Club A event from a
      stale Tab 1 — confirm rejection and the event's `status` is unchanged

## 3. Stale lesson write blocked

- [ ] Induce staleness with Tab 1 on `/lessons` or `/my-schedule?tab=lessons`
- [ ] Attempt to submit a new lesson request — confirm rejection with the
      stale-club message and no row is created in the lesson requests table
- [ ] Attempt to withdraw an existing pending request — confirm rejection
      and the request's status is unchanged
- [ ] Attempt to cancel a confirmed lesson (both from the member lesson
      detail sheet and, as an admin/pro, from `LessonProSheet`) — confirm
      rejection and the lesson's status is unchanged

## 4. Stale admin court/event write blocked

- [ ] As an admin test account, induce staleness with Tab 1 on
      `/admin/courts` — attempt to add, rename, reorder, activate/deactivate,
      and delete a court; confirm each is rejected with the stale-club
      message and no `courts` row is created/changed
- [ ] Induce staleness with Tab 1 on `/admin/events` (or the Events "Manage"
      tab) — attempt to add a member/guest/roster-member to an event's
      roster, remove a participant, force-confirm, offer/expire a spot,
      remove a guest, archive/unarchive an event, and toggle member-joinable;
      confirm each is rejected with the stale-club message and no
      underlying row changes

## 4b. Stale event/maintenance-block creation, attendance change, and admin lesson creation blocked (Phase 26F1 correction)

These four mutations were originally deferred (they called their RPC
directly from a client component rather than through a Server Action) and
are now routed through `createEvent`/`createMaintenanceBlocks`/
`markAttendance`/`adminCreateLessonRequestAction`, each guarded the same way
as every other action in this checklist.

- [ ] As an admin/pro, induce staleness with Tab 1 on `/calendar` with the
      "Create Event" sheet open — submit — confirm rejection with the
      stale-club message and no row is created in `events`
- [ ] Induce staleness with Tab 1 on `/calendar` with the "Block Court(s)"
      (maintenance) sheet open — submit — confirm rejection with the
      stale-club message and no row is created in `reservations` with
      `reason = 'maintenance'`
- [ ] Induce staleness with Tab 1 on an open Event Roster sheet — mark a
      participant's attendance (Attended/No Show) — confirm rejection with
      the stale-club message, the optimistic UI update rolls back to the
      prior value, and the row's `attendance_status` in `event_participants`
      is unchanged
- [ ] As an admin, induce staleness with Tab 1 on the "Create Lesson
      Request" admin sheet (from `/admin/lessons` or a member detail page)
      — submit — confirm rejection with the stale-club message and no row
      is created in the lesson requests table

## 5. Current-club writes still succeed

- [ ] Using a fresh, non-stale session (single-club disposable account, or
      the multi-club account with a freshly reloaded page matching its
      current active club), repeat one representative action from each of
      sections 1–4 (book a court, join an event, submit a lesson request,
      add a court) — confirm every one succeeds exactly as before this
      checkpoint, with no new errors or behavior changes
- [ ] Confirm the success paths' existing side effects are intact:
      SMS/email dispatch on booking and event-join, `revalidatePath` refresh
      of the relevant page, roster/occupancy counts updating in the UI
- [ ] Non-stale, repeat the four Section 4b actions (create event, create a
      maintenance block, mark attendance, admin-create a lesson request) —
      confirm each succeeds exactly as before this checkpoint: the event/
      block/lesson-request row is created, the attendance status is saved,
      and existing behavior (sheet closes, list refreshes, pro/member
      notifications on admin-created lesson requests) is unchanged

## 6. No cross-club record is created or changed

- [ ] For every "blocked" scenario in sections 1–4, confirm via SQL that
      **no row was created or modified in either club** — not the stale
      page's club (Club A) and not the account's actual current club
      (Club B). The guard fails closed before any RPC/table write runs; it
      never falls back to writing against the account's real current club
      on the caller's behalf
- [ ] Confirm `expectedClubId` is never used to select or authorize a
      target club anywhere — spot-check that a manually stale/incorrect
      `expectedClubId` (e.g. a valid UUID for a club the account has no
      membership in at all) is also rejected with `stale_club_context`,
      not silently ignored or treated as an authorization override

## 7. Existing one-club behavior unchanged

- [ ] For a single-club account (never switches clubs), confirm every
      protected action in sections 1–4 behaves identically to before this
      checkpoint — same success paths, same existing error messages for
      pre-existing error codes (e.g. `event_full`, `already_joined`,
      `court_has_future_reservations`), no new prompts or friction
- [ ] Confirm the Phase 26E2 `StaleActiveClubGuard` overlay still behaves
      independently — this checkpoint does not replace, duplicate, or
      change its blocking-overlay/reload behavior; it only adds a second,
      narrower check at the point of write for the gap the overlay's
      periodic re-check can miss
