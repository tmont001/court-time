# QA — Phase 27E: Program Lifecycle and Future-Session Handling

Manual QA for `supabase/migrations/0094_program_lifecycle.sql` and the accompanying UI. Run
against a disposable/staging database with migration 0094 applied.

## Setup

1. Club C1: admin **A1**; pro **P1**; a second pro **P2** (not the creator of any test program);
   member **M1**.
2. Club C2 (different club): admin **A2**.
3. `progA` in C1: `enrollment_model='program'`, created by P1, `status='active'`, generated with
   both a **past** session (backdate one occurrence, or wait) and at least 2 **future** sessions.
   Enroll M1 (`enrolled`) via `join_program`, and have at least one `waitlisted` member.
4. `progB` in C1: same as progA but created by P1 as well, for the completion tests — generated
   with only sessions inside the next few days (so `ends_on` can plausibly be reached), or
   generated fully through `ends_on` with no gaps.
5. `progC` in C1: still `draft` (never generated), created by A1.
6. `progOther` in C2: any state, for cross-club isolation checks.

## 1. Cancel — authorization

- P2 (not progA's creator) calls `cancel_program(progA)`. Expect `insufficient_role`.
- M1 (member) calls `cancel_program(progA)`. Expect `insufficient_role`.
- A1 calls `cancel_program(progOther)` (cross-club). Expect `program_not_found`.
- P1 (creator) calls `cancel_program(progA)`. Expect success, `status='cancelled'`.

## 2. Cancel — draft is cancellable

- A1 calls `cancel_program(progC)` (draft, never generated). Expect success, `status='cancelled'`,
  zero events touched (`metadata.cancelled_event_count = 0` in `audit_log`).

## 3. Cancel — invalid states rejected

- A1 calls `cancel_program(progA)` again (already cancelled from §1). Expect
  `program_not_cancellable`.

## 4. Cancel — future events cancelled, past preserved

- Before cancelling a fresh program (repeat setup on a new `progD`), note its past event's
  `status`. After `cancel_program(progD)`: confirm every **future**, non-archived, `scheduled`
  event under progD is now `status='cancelled'`; confirm the **past** event's `status` is
  unchanged (still whatever it was before — cancellation never touches `starts_at < now()`
  events). Confirm via `verify_phase27e.sql` block H (should be empty for progD).

## 5. Cancel — reservations and offered participants released

- Confirm every future event's `reservations` rows that were `pending`/`confirmed` are now
  `status='cancelled'` with `cancelled_at`/`cancelled_by`/`cancellation_kind='admin'` set.
- If any future event had a live `offered` `event_participants` row, confirm it is now
  `status='cancelled'` with `offer_expires_at` cleared.
- Confirm any `confirmed`/`waitlisted` `event_participants` rows on those future events are
  **untouched** (still their original status) — only `offered` rows are cancelled, matching
  `cancel_event`'s own precedent.

## 6. Cancel — program_enrollments preserved as historical record

- After cancelling progD (which had M1 `enrolled` and another member `waitlisted`), confirm
  `program_enrollments` rows for both are **completely unchanged** — same `status`, same
  `waitlisted_at`, same `updated_at` as immediately before the cancellation. `cancel_program` must
  never write to `program_enrollments`.

## 7. Cancel — blocks future enrollment and generation (no new guard needed)

- After cancelling progD, a member calls `join_program(progD)`. Expect `program_not_enrollable`
  (via the existing, unmodified `_program_is_enrollable` check — confirms no new code path was
  needed).
- A1 calls `add_program_member(progD, M1)`. Expect `program_not_enrollable`.
- A1 calls `generate_program_sessions(progD, ...)`. Expect `program_not_generatable` (existing,
  unmodified guard from 0091).

## 8. Complete — eligibility gate (window not yet ended, sessions remain)

- On a fresh `progE` with `ends_on` far in the future and future generated sessions still
  pending, A1 calls `complete_program(progE)`. Expect `program_not_completable`.

## 9. Complete — eligible via no future sessions remaining

- On `progB` (fully generated through `ends_on`, no gaps, but `ends_on` itself still in the
  future), confirm (or generate through) so that **no** `scheduled`, non-archived, future event
  remains under it. A1 calls `complete_program(progB)`. Expect success, `status='completed'`,
  `audit_log.metadata.had_future_sessions = false`.

## 10. Complete — eligible via window ended

- On a program whose `ends_on` has passed (test data setup) but which still has a stray future-
  dated generated event (shouldn't normally happen, but confirms the OR condition), call
  `complete_program`. Expect success — `window_ended = true` alone is sufficient regardless of
  `had_future_sessions`.

## 11. Complete — authorization mirrors cancel

- P2 calls `complete_program` on P1's program. Expect `insufficient_role`.
- M1 calls it. Expect `insufficient_role`.
- A1 calls it cross-club. Expect `program_not_found`.
- A1 calls `complete_program` on an already-`cancelled` or already-`completed` program. Expect
  `program_not_completable`.

## 12. Complete — never touches events or program_enrollments

- Confirm no `events`, `reservations`, `event_participants`, or `program_enrollments` row changes
  as a result of `complete_program` — only `programs.status`/`updated_at` change.

## 13. Archive — only cancelled/completed programs

- A1 calls `archive_program` on a still-`draft` or still-`active` program. Expect
  `program_not_archivable`.
- A1 calls `archive_program` on the now-`cancelled` progD. Expect success, `archived_at`/
  `archived_by` set.
- A1 calls `archive_program` on progD again. Expect `already_archived`.

## 14. Archive — authorization mirrors cancel/complete

- P2 calls `archive_program` on P1's cancelled program. Expect `insufficient_role`.
- M1 calls it. Expect `insufficient_role`.
- A1 calls it cross-club. Expect `program_not_found`.

## 15. Archive — no cascading changes

- Confirm archiving progD does not change any `program_schedule_rules`, `program_enrollments`,
  `events`, `event_participants`, or `audit_log` row other than the new `archive_program`
  audit entry itself and `programs.archived_at`/`archived_by`/`updated_at`.

## 16. Unarchive — reverses cleanly

- A1 calls `unarchive_program(progD)`. Expect success, `archived_at`/`archived_by` both `null`
  again, `status` unchanged (still `cancelled`).
- A1 calls `unarchive_program(progD)` again. Expect `not_archived`.
- Same authorization rules as archive (pro-own-only, member forbidden, cross-club not-found) —
  spot-check at least one.

## 17. Concurrency — cancel racing a member join

- On a fresh program with a spot free, fire `join_program` (as a member) and `cancel_program` (as
  A1) from two parallel connections at effectively the same time. Expect: whichever commits first
  is what the other sees — either the join fully lands (`enrolled`, materialized into then-still-
  future events) and cancel then correctly cancels those same now-existing future events, or
  cancel commits first (status flips) and the join is then correctly rejected with
  `program_not_enrollable`. Never a partial/inconsistent result (e.g., an `enrolled` member left
  materialized into an event that itself never got cancelled).

## 18. Concurrency — cancel racing generation

- On a program with a schedule rule not yet generated through some future date, fire
  `generate_program_sessions` (extending through that date) and `cancel_program` from two parallel
  connections at effectively the same time. Expect: if generation commits first, the newly
  generated future event is included in cancel_program's bulk cancellation (it was `scheduled`,
  non-archived, future at the time cancel's `array_agg` ran, since cancel only starts after
  generation's lock is released). If cancellation commits first, generation's own
  `program_not_generatable` guard rejects the concurrent call outright (status is no longer
  `'draft'` or `'active'`).

## 19. Concurrency — two simultaneous cancel attempts

- Two admins call `cancel_program` on the same program at effectively the same time. Expect
  exactly one succeeds; the other receives `program_not_cancellable` (the first call's lock is
  held until commit, so the second sees the already-`cancelled` state once it acquires the lock).

## 20. No direct authenticated writes

- Confirm via `verify_phase27e.sql` block C that `programs`, `events`, `reservations`,
  `event_participants`, and `program_enrollments` all show `authenticated -> SELECT` only. This
  migration adds no write grant to any of them.

## 21. Correct PUBLIC/anon/authenticated function grants

- Run `verify_phase27e.sql` blocks A, B, D, and E and confirm every expectation stated inline,
  including the source-text proof that all four functions use only
  `current_user_club_id()`/`current_user_role()` and never `profiles.club_id/role/status/
  is_lesson_provider`.

## 22. Existing flows regression

- `join_program`/`leave_program`/`accept_program_waitlist_offer`/`decline_program_waitlist_offer`
  (0091), `add_program_member`/`remove_program_member`/`get_program_roster` (0092),
  `get_program_eligible_members` (0093), and `create_program`/`update_program`/
  `preview_program_sessions`/`generate_program_sessions` (0088-0091) all behave identically on a
  program untouched by this checkpoint's testing — this migration adds four new functions only and
  does not modify any existing one.

## UI checklist

23. **Draft program card**: shows Cancel (destructive) alongside Preview & Generate.
24. **Active program card**: shows View Sessions, Roster (whole-program only), Cancel
    (destructive), Manage Sessions; shows Complete only when the client-side eligibility hint
    (`ends_on` passed or no `next_session_starts_at`) holds — clicking it when genuinely eligible
    succeeds; if the client-side hint is stale (race with a real generation), the RPC's own
    `program_not_completable` renders as a stable inline error, never a raw database message.
25. **Cancelled/completed, non-archived card**: shows View Sessions and Archive (destructive) only
    — no Cancel/Complete/Roster/Manage Sessions.
26. **Archived card**: shows only Unarchive (primary) and, if kept, View Sessions — no other
    lifecycle or management action.
27. Cancel and Archive both require an inline confirmation step before the RPC is called; Cancel
    dismisses cleanly with no call made.
28. Loading state disables the button mid-request and shows action-specific pending text; a
    failed call shows a stable inline error, never a raw Postgres message.
29. The Active/Archived/All filter (if implemented) correctly shows/hides archived programs; the
    default view excludes archived programs.
30. After any successful lifecycle action, the Programs list, `/calendar`, and `/my-schedule`
    (for cancel, since it can release reservations) all reflect the change after refresh.

## Cleanup

Delete all test programs, their generated events/reservations, and test `program_enrollments`/
`event_participants`/`audit_log` rows created above before treating the environment as clean.
