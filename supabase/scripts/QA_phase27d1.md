# QA — Phase 27D1: Whole-Program Enrollment Backend

Manual QA for `supabase/migrations/0091_whole_program_enrollment.sql`, including the 0091
correction pass (generation/enrollment locking, FIFO rejoin fairness, the program lifecycle
contract, and the event_participants direct-write correction). No UI exists yet for this
checkpoint — every step below is driven directly via RPC calls (Supabase SQL Editor `select
public.join_program('<uuid>');` style, or the JS client `supabase.rpc(...)` from a scratch script/
REPL while authenticated as the relevant test user). Run against a disposable/staging database.

## Setup

1. As an admin, create a program with `enrollment_model = 'program'`, `default_capacity = 2`, at
   least one schedule rule with a court assigned, `starts_on`/`ends_on` covering the next 2 weeks.
2. `generate_program_sessions` it so it has at least 2 future generated events.
3. Have at least 4 distinct member profiles in the same club, all with active membership
   (`club_memberships.status = 'active'`), available to enroll: M1, M2, M3, M4.
4. Have one member in a *different* club (M_other) for cross-club isolation checks.
5. Have one member with an *inactive* membership in the same club (M_inactive) for the inactive-
   membership rejection check.
6. Also create a second program with `enrollment_model = 'per_session'` and a third with
   `enrollment_model = 'admin_managed'`, both generated, for the wrong-model rejection checks.
7. Also create a fourth program with `enrollment_model = 'program'` left in `draft` (never
   generated) for the lifecycle rejection checks, and a fifth, generated and active, with
   `ends_on` set to yesterday for the ended-program rejection checks.

## 1. Successful enrollment (capacity available)

- M1 calls `join_program(program_id)`. Expect: returns a row with `status = 'enrolled'`.
- Query `event_participants` for every future generated event under the program: M1 has a
  `confirmed` row on each.
- `audit_log` has a `join_program` entry for M1.

## 2. Waitlisting when capacity is full

- M2 calls `join_program`. Expect `status = 'enrolled'` (capacity 2, 1 used).
- M3 calls `join_program`. Expect `status = 'waitlisted'` (capacity now full: 2 enrolled).
- Confirm M3 has **no** `event_participants` rows for this program's events.
- Confirm M3's row has `waitlisted_at` set to (approximately) the time of this call.

## 3. Capacity counting includes offered rows, not just enrolled

- Have M2 `leave_program` (frees a spot; see §7, this also triggers a promotion — for this step,
  first re-fill to capacity, then have M4 `join_program` while M3 is already offered — see §4
  below for how a member becomes 'offered' — and confirm M4 lands `waitlisted`, not `enrolled`,
  because the offered row already counts toward capacity).

## 4. Deterministic FIFO promotion + expired-offer capacity release

- With M1 enrolled and M2 enrolled (capacity 2 full), have M1 `leave_program`.
- Expect: M1 -> `cancelled`; the *oldest* waitlisted member by `waitlisted_at` (whichever of
  M3/M4 joined the waitlist first) is now `offered` with `offer_expires_at` set ~`club_settings.
  waitlist_offer_window_hours` (or 2h default) in the future, and their `waitlisted_at` is now
  `null` (cleared on the transition to `offered`).
- Manually backdate that row's `offer_expires_at` to the past (SQL Editor, direct UPDATE — test
  data only) to simulate expiry, then have any member call `join_program` or `leave_program`
  again (any RPC that runs the expire/advance chain) — or wait for real expiry.
- Expect: the expired `offered` row flips to `cancelled` (audit_log
  `program_waitlist_offer_expired`), and the *next* waitlisted member is now offered in its place.
  Confirm no more than one live (`offer_expires_at > now()`) offered row exists at a time
  (`verify_phase27d1.sql` block M).

## 5. Accept offer

- With a member in `offered` status and a non-expired `offer_expires_at`, that member calls
  `accept_program_waitlist_offer(program_id)`. Expect `status = 'enrolled'`.
- Confirm that member now has a `confirmed` `event_participants` row on every future generated
  event under the program (materialization on accept, not just on initial join).
- Call `accept_program_waitlist_offer` again as the same member. Expect `offer_not_found` (no
  longer `offered`) — confirms it is not spuriously re-acceptable after success.

## 6. Decline offer

- Get a different member into `offered` status (repeat the leave/promote flow from §4).
- That member calls `decline_program_waitlist_offer(program_id)`. Expect `status = 'cancelled'`.
- Confirm they have **no** materialized `event_participants` rows from this decline.
- Confirm the decline triggers promotion: the next waitlisted member (if any) becomes `offered`.

## 7. Leaving an enrolled member promotes the next waitlisted member

- With capacity full (2 enrolled) and at least 1 waitlisted, have an enrolled member
  `leave_program`. Expect: their status -> `cancelled`; their future `event_participants` rows for
  this program all move to `cancelled`; the oldest waitlisted member becomes `offered`.

## 8. Leaving a waitlisted member does not trigger promotion

- With a member in `waitlisted` status (capacity already full via others), have them
  `leave_program`. Expect: `status = 'cancelled'` and `waitlisted_at` cleared back to `null`, and
  no other member's status changes (no spot was freed since a waitlisted row was never counted
  against capacity).

## 9. Cancelled member rejoins behind existing waitlisted members (fresh FIFO position)

- Get M3 to `waitlisted` (capacity full, no live offer). Note M3's `waitlisted_at`.
- Have M3 `leave_program` (-> `cancelled`, `waitlisted_at` cleared to `null`).
- Get M5 (a fifth member; add one to Setup if needed) onto the waitlist (capacity still full).
  Note M5's `waitlisted_at`.
- Have M3 call `join_program` again (rejoin from `cancelled`). Capacity is still full, so M3
  lands `waitlisted` again with a **new** `waitlisted_at` set to the rejoin time — strictly later
  than M5's `waitlisted_at`.
- Free a spot (have an enrolled member `leave_program`). Expect: **M5 is offered, not M3** — the
  rejoined member (M3) goes to the back of the queue behind the member who was already waiting
  (M5), confirming the promotion used `waitlisted_at`, not the original `created_at` from M3's
  first-ever join (which would have incorrectly put M3 ahead of M5).

## 10. New caller cannot bypass an existing waitlist when capacity is open

- Set up: capacity 3, 1 enrolled, 1 member (M_a) currently `offered` (live, unexpired offer), 1
  member (M_b) `waitlisted`. Raw count(enrolled+offered) = 2 < capacity 3 — a spot is
  technically open by count alone, but `_advance_program_waitlist_offer`'s one-live-offer-at-a-
  time policy means M_b cannot yet be offered that spot.
- A brand-new caller (M_c, never enrolled in this program before) calls `join_program`.
- Expect: M_c lands `waitlisted`, **not** `enrolled` — the queue-bypass guard (see migration
  header, "Deliberate departures" item 5) forces any new caller to the waitlist whenever anyone
  is already waitlisted, regardless of raw capacity count. Confirm M_c's `waitlisted_at` is later
  than M_b's, so M_b remains ahead of M_c.

## 11. FIFO ordering remains deterministic after cancel/rejoin cycles

- Starting from a clean waitlist, put M2, M3, M4 on the waitlist in that order (capacity full
  throughout). Confirm `verify_phase27d1.sql`-style ordering (`select profile_id, waitlisted_at
  from program_enrollments where program_id = ... and status = 'waitlisted' order by
  waitlisted_at asc, id asc`) shows M2, M3, M4 in that exact order.
- Have M3 leave and immediately rejoin (still full capacity). Re-run the ordering query: expect
  M2, M4, M3 — M3 has moved to the back, M2 and M4's relative order is unchanged.
- Repeat once more with M2 leaving and rejoining: expect M4, M3, M2. Confirm the ordering is
  reproducible and depends only on the most recent `waitlisted_at` per member, never on
  historical `created_at` or call order coincidences.

## 12. Idempotency

- An already-`enrolled` member calls `join_program` again. Expect: returns their existing row
  unchanged (`status = 'enrolled'`), no new audit_log entry, no duplicate materialization rows.
- An `offered` or `waitlisted` member calls `join_program` again. Expect `already_enrolled`.

## 13. Concurrency safety — simultaneous joins never overfill

- With exactly 1 spot free, fire two `join_program` calls from two different members at
  effectively the same time (two parallel `psql`/script connections issuing the call together).
  Expect: exactly one lands `enrolled`, the other lands `waitlisted` — never both `enrolled`.
  Confirm via `verify_phase27d1.sql` block L (`held_count <= default_capacity`).

## 14. Concurrency safety — simultaneous promotions never double-offer

- With 2+ waitlisted members and a spot about to free up, fire two operations that would each
  attempt to promote (e.g., two admins independently triggering flows that call
  `_advance_program_waitlist_offer` indirectly, or two rapid `leave_program` calls freeing two
  spots at once) and confirm no more than one *new* live offer appears per available spot — no
  member ends up double-offered, and `verify_phase27d1.sql` block M stays empty throughout.

## 15. Concurrency safety — generation racing a join

- Set up a program with a schedule rule that has not yet been generated through some future date
  (i.e. `generate_program_sessions` with a `p_through_date` will create at least one brand-new
  event). Do **not** call generate yet.
- Fire `join_program` (for a member not yet enrolled) and `generate_program_sessions` (extending
  through the new date) from two parallel connections at effectively the same time.
- Expect exactly one of two consistent outcomes, never a hybrid: either (a) the join fully
  commits first and the new event — once generated — already has a `confirmed`
  `event_participants` row for that member from generation's own materialization step, or (b)
  generation fully commits first and the join's own materialization step (running after,
  unblocked) picks up the freshly-created event. In both cases, once both calls have returned,
  query `event_participants` for the new event and confirm the member has exactly one
  `confirmed` row — never zero (the bug this correction fixes) and never more than one.

## 16. Concurrency safety — generation racing a leave

- Enroll a member, then (without generating yet) extend the program's schedule so a new
  occurrence is pending generation, matching §15's setup, except the member is already
  `enrolled` beforehand.
- Fire `leave_program` (for that member) and `generate_program_sessions` (extending through the
  new date) from two parallel connections at effectively the same time.
- Expect: once both calls return, the member has **no** `confirmed` `event_participants` row on
  the newly generated event — regardless of which call actually committed first. If leave
  committed first, generation's own materialization step correctly excludes them (their
  `program_enrollments.status` is already `cancelled` by the time generation's SELECT runs). If
  generation committed first, leave's own `_cancel_program_member_future_participation` (running
  after, unblocked) finds and cancels the row generation just created, since that event already
  matches leave's own future/scheduled/non-archived criteria.

## 17. Cross-club isolation

- M_other (different club) calls `join_program(program_id)` for a program in a club they do not
  belong to. Expect `program_not_found` — never a different error, never a leak of program
  existence/details across clubs.

## 18. Inactive membership rejection

- M_inactive (inactive membership in the correct club) calls `join_program`. Expect
  `not_authenticated` (since `current_user_club_id()` returns NULL for any caller without an
  *active* membership — this is intentional per the membership-native authorization convention,
  not a bug).

## 19. Per-session / admin-managed program rejection

- Any member calls `join_program` against the `per_session` program created in Setup. Expect
  `program_not_whole_enrollment`.
- Same against the `admin_managed` program. Expect `program_not_whole_enrollment`.
- Repeat for `leave_program`, `accept_program_waitlist_offer`, `decline_program_waitlist_offer`
  against both wrong-model programs — same error expected on all four RPCs.

## 20. Program lifecycle — draft program rejection

- A member calls `join_program` against the draft program from Setup step 7 (never generated).
  Expect `program_not_enrollable`.
- Confirm via `verify_phase27d1.sql` block O that no `program_enrollments` row exists for any
  draft program (this should already be empty, and stay empty after this attempt).

## 21. Program lifecycle — ended program rejection

- A member calls `join_program` against the fifth program from Setup step 7 (`ends_on` set to
  yesterday, status `active`). Expect `program_not_enrollable`.

## 22. Program lifecycle — accept rejected once the program is no longer enrollable

- Get a member into `offered` status on a normal active/within-window program (as in §4).
- Before they accept, manually update that program's `ends_on` to yesterday (test data setup
  only, simulating the window having naturally ended between the offer and the accept).
- The offered member calls `accept_program_waitlist_offer`. Expect `program_not_enrollable` —
  confirms the lifecycle re-check inside accept, not just at join time.
- Confirm the member's row is unchanged (still `offered`, not silently cancelled) — a rejected
  accept is not the same as a decline; the caller can still legitimately decline afterward (see
  §23).

## 23. Program lifecycle — leave and decline remain available as cleanup

- The member left `offered` in §22 (now on a program whose `ends_on` has passed) calls
  `decline_program_waitlist_offer`. Expect success (`status = 'cancelled'`), not
  `program_not_enrollable` — decline has no lifecycle gate, matching the migration header's
  lifecycle matrix.
- Separately, an `enrolled` member on a program that has since become archived (set
  `archived_at` via test data setup) calls `leave_program`. Expect success — leave has no
  lifecycle gate either.

## 24. Future materialization on initial join

- Already covered in §1 — restated as its own check: confirm the *count* of `event_participants`
  rows created for a newly-enrolled member exactly equals the number of applicable future
  generated events (`status='scheduled'`, `archived_at is null`, `starts_at >= now()`) under the
  program at the time of joining — not more, not fewer, and none on past/archived/cancelled
  events.

## 25. New event generated after enrollment inherits already-enrolled members

- With M1 already `enrolled`, call `generate_program_sessions` again for the same program with a
  `p_through_date` extending further into the future (generating at least one brand-new event).
  Expect: the new event has a `confirmed` `event_participants` row for M1 automatically, with no
  extra call needed. Confirm any `waitlisted`/`offered` member has **no** row on the new event.

## 26. Leaving preserves past attendance

- Manually mark a *past* event's `event_participants` row for an enrolled member as
  `attendance_status = 'attended'` (or `'no_show'`) via direct SQL (test data setup only).
  Have that member `leave_program`. Expect: the past row is untouched (still `confirmed`,
  attendance_status unchanged) — only future rows flip to `cancelled`.

## 27. `member_joinable` correctness per model

- Confirm (via `verify_phase27d1.sql` block K) that every generated event under the `program` and
  `admin_managed` programs has `member_joinable = false`, and every generated event under the
  `per_session` program has `member_joinable = true`. This was already true before 0091 (unchanged
  formula) — this check exists to confirm the correction pass did not regress it.

## 28. No direct writes possible (event_participants correction)

- As the `authenticated` Postgres role (not via RPC — e.g. a `psql` session authenticated as that
  role, or by inspecting grants), attempt a raw `insert`/`update`/`delete` against
  `program_enrollments` or `event_participants`. Expect: both tables — only SELECT succeeds, every
  write attempt fails with a permission-denied error at the grant level (not an RLS-policy
  rejection — the underlying table privilege itself is gone for `event_participants` as of this
  correction pass; see `verify_phase27d1.sql` block E).
- Confirm the two dead RLS policies from 0004 (`event_participants_insert_own`,
  `event_participants_cancel_own`) no longer exist (`verify_phase27d1.sql` block H).
- Confirm every existing feature that writes to `event_participants` still works end-to-end
  through its RPC: join/leave/accept/decline a plain (non-program) event, and admin add/remove a
  participant — none of these should be affected, since none of them ever performed a direct
  table write in the first place (see migration header, RLS/grants note, for the call-site audit).

## 29. Grants / authorization

- Confirm `anon` and `PUBLIC` cannot execute any of the four public RPCs or
  `generate_program_sessions` (expect a permission-denied error, not a stable app error code —
  this is a role-level EXECUTE grant check, before the function body ever runs).
- Confirm `authenticated` can execute all five.
- Confirm none of the five private helpers (`_expire_stale_program_offers`,
  `_advance_program_waitlist_offer`, `_materialize_program_member_into_future_events`,
  `_cancel_program_member_future_participation`, `_program_is_enrollable`) is directly callable by
  any role.
- Run `verify_phase27d1.sql` blocks A–C and P and confirm every expectation stated inline in that
  file, including the source-text proof that `for update` locking is present in all five
  functions that need it.

## 30. Regression: prior Phase 27 checkpoints still function

- `create_program`, `update_program` (draft-only editing), `preview_program_sessions`, and
  `generate_program_sessions` for a **new** program (unrelated to the whole-program enrollment
  test program above) all still behave exactly as before this migration — create a fresh draft
  program, preview it, edit it, generate it, confirm events + reservations appear as expected,
  with no behavior change introduced by `generate_program_sessions`'s `CREATE OR REPLACE`
  (locking + materialization additions only).
- Existing per-session `join_event`/`leave_event`/`accept_waitlist_offer`/
  `decline_waitlist_offer` flows on ordinary (non-program) events are unaffected — spot-check one
  join/leave/waitlist cycle on a plain event to confirm nothing changed there.

## Cleanup

Delete all test programs, their generated events/reservations, and test `program_enrollments`/
`event_participants` rows created above before treating the environment as clean.
