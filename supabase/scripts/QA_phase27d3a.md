# QA — Phase 27D3A: Admin/Pro Program Roster Backend

Manual QA for `supabase/migrations/0092_program_roster_management.sql`. No UI exists yet for this
checkpoint — every step below is driven directly via RPC calls (Supabase SQL Editor
`select public.add_program_member('<program_id>', '<profile_id>');` style, or the JS client
`supabase.rpc(...)` from a scratch script/REPL while authenticated as the relevant test user). Run
against a disposable/staging database.

## Setup

1. Club C1: admin **A1**; pro **P1**; a second pro **P2** (not the creator of any test program);
   members **M1**, **M2**, **M3**, **M5** (all active club_memberships); member **M4** with an
   **inactive** club_memberships row in C1.
2. Club C2 (different club): admin **A2**, member **M_other**.
3. `prog1` in C1: `enrollment_model='program'`, `default_capacity=2`, created by **P1**, status
   `active`, generated with at least 2 future sessions. Pre-seed: M2 `enrolled`, M3 `waitlisted`
   (via `join_program`, not the new RPCs, to keep this setup independent of the code under test).
4. `prog2` in C1: `enrollment_model='per_session'`, generated. `prog3` in C1:
   `enrollment_model='admin_managed'`, generated.
5. `prog4` in C1: `enrollment_model='program'`, status `draft` (never generated).
6. `prog5` in C1: `enrollment_model='program'`, status `active`, generated, `ends_on` set to
   yesterday.
7. `prog6` in C1: `enrollment_model='program'`, status `active`, generated, then `archived_at` set
   (test data setup).
8. `prog_other` in C2: `enrollment_model='program'`, active, generated.

## 1. Admin can view and manage a same-club program

- A1 calls `get_program_roster(prog1)`. Expect: rows for M2 (`enrolled`) and M3 (`waitlisted`),
  ordered enrolled-then-waitlisted; A1 sees `email` populated for both.
- A1 calls `add_program_member(prog1, M1)` and `remove_program_member(prog1, M1)`. Both succeed.

## 2. Pro can manage their own program

- P1 (creator of prog1) calls all three RPCs against prog1. All succeed identically to A1's calls,
  except P1 sees `email = null` on every roster row (see §24 for why).

## 3. Pro cannot manage another pro's program

- P2 calls `get_program_roster(prog1)`, `add_program_member(prog1, M1)`, and
  `remove_program_member(prog1, M2)`. Expect `insufficient_role` on all three.

## 4. Member cannot call staff RPCs

- M1 calls all three RPCs against prog1 (a program they are not even enrolled in, and separately
  one they are). Expect `insufficient_role` on all three, regardless of M1's own enrollment state
  in that program.

## 5. Cross-club program isolation

- A1 calls all three RPCs with `prog_other`'s id (a real program, but in C2, not A1's club).
  Expect `program_not_found` — never a different error, never any leak of prog_other's existence
  or details.

## 6. Inactive or other-club target rejection

- A1 calls `add_program_member(prog1, M4)` (M4's C1 membership is inactive). Expect
  `target_member_inactive`.
- A1 calls `add_program_member(prog1, M_other)` (M_other has no C1 membership at all). Expect
  `target_member_not_found`.
- Confirm `remove_program_member` does **not** perform this check: if M4 or a since-removed member
  has an existing enrolled/waitlisted/offered row in prog1 (set up via direct test data, since
  add_program_member would reject them), `remove_program_member(prog1, M4)` still succeeds — see
  §8 in the migration header rationale ("remove must remain available as cleanup regardless of the
  target's current membership state").

## 7. Per-session and admin-managed program rejection

- A1 calls all three RPCs against `prog2` (per_session) and `prog3` (admin_managed). Expect
  `program_not_whole_enrollment` on every call.

## 8. Draft, archived, and ended program rejection for adding

- A1 calls `add_program_member(prog4, M1)` (draft). Expect `program_not_enrollable`.
- A1 calls `add_program_member(prog5, M1)` (ends_on passed). Expect `program_not_enrollable`.
- A1 calls `add_program_member(prog6, M1)` (archived). Expect `program_not_enrollable`.
- Contrast: A1 calls `get_program_roster(prog5)` and `get_program_roster(prog6)` — both succeed
  (viewing a roster is not gated on enrollability). If prog5/prog6 have any pre-existing enrolled/
  waitlisted/offered rows (set up via test data), `remove_program_member` against them also
  succeeds — removal is not gated on enrollability either, matching leave_program's own precedent.

## 9. Existing enrolled target is idempotent

- A1 calls `add_program_member(prog1, M2)` (M2 already `enrolled`). Expect: returns M2's existing
  row unchanged (`status='enrolled'`, same `updated_at` as before the call — no UPDATE actually
  ran). `audit_log` still gets a new `add_program_member` entry with `metadata.no_op = true`.

## 10. Existing waitlisted/offered target is not reordered

- A1 calls `add_program_member(prog1, M3)` (M3 `waitlisted`). Expect: returns M3's existing row
  **exactly unchanged** — `status='waitlisted'`, and `waitlisted_at`, `offer_expires_at`, and
  `updated_at` all identical to their values immediately before the call (byte-for-byte, not just
  "still waitlisted"). `audit_log` gets a new `add_program_member` entry with `metadata.no_op =
  true`, but no `program_waitlist_offer_expired` or promotion-related entry from this call.
- Repeat with a spot free (e.g. cancel M2 first via direct test data or `remove_program_member`)
  and M3 already the front of the queue. Expect: **still no change** — `add_program_member` must
  not run `_expire_stale_program_offers`/`_advance_program_waitlist_offer` for an
  already-waitlisted/offered target under any circumstance, including one where a promotion would
  otherwise be "due." M3 remains `waitlisted` with their original `waitlisted_at` until some other
  call (a member's own `join_program`/`leave_program`, or `remove_program_member` on someone else)
  triggers the routine queue maintenance that would promote them.
- Repeat once more with M3 `offered` instead (a live, non-expired offer). Expect: `status`,
  `offer_expires_at`, and `updated_at` all unchanged by the `add_program_member` call.
- Repeat with M3 `offered` but with a **backdated (expired)** `offer_expires_at` (test data only).
  Expect: `add_program_member(prog1, M3)` still returns the row exactly as stored — still
  `status='offered'` with the same (expired) `offer_expires_at` — because this call never runs
  `_expire_stale_program_offers` for an already-offered target. Confirm expiry only happens later,
  via some other call that legitimately triggers it (e.g. M3 or another member calling
  `join_program`/`leave_program`, or an admin calling `remove_program_member` on someone else).

## 11. Cancelled member re-added with a fresh queue position

- Get M5 to a `cancelled` state in prog1 (join then leave, or direct test data). With prog1 at
  capacity and another member already waitlisted ahead in time, A1 calls
  `add_program_member(prog1, M5)`. Expect: M5 lands `waitlisted` with a **new** `waitlisted_at`
  strictly later than the existing waitlisted member's — M5 goes to the back of the queue, not
  reusing any stale timestamp.

## 12. Existing waitlist cannot be bypassed

- With prog1 at a capacity/offered state where raw count looks technically open (e.g. capacity 3,
  1 enrolled, 1 live offer outstanding, 1 person already waitlisted — see Phase 27D1's own QA for
  how to construct this), A1 calls `add_program_member(prog1, <brand-new member>)`. Expect: the
  new target lands `waitlisted`, never `enrolled`, even though raw enrolled+offered count is under
  capacity — matching join_program's own queue-bypass guard exactly.

## 13. Capacity counts valid offered spots

- With prog1's capacity fully consumed by a mix of `enrolled` + one live `offered` row, A1 calls
  `add_program_member` for a new target. Expect `waitlisted`, not `enrolled` — the offered row
  correctly counts against capacity.

## 14. Expired offers release capacity

- Backdate a live offered row's `offer_expires_at` to the past (test data only). A1 calls
  `add_program_member` for a different, new target. Expect: the expired offer is cancelled first
  (`audit_log` shows `program_waitlist_offer_expired`), freeing a real spot that the new target (or
  the next waitlisted member, per FIFO) can now occupy.

## 15. Enrolled member materializes into future generated events

- After `add_program_member` results in `status='enrolled'` for some target, confirm
  `event_participants` has a `confirmed` row for that profile on every future generated event
  under prog1 (`status='scheduled'`, `archived_at is null`, `starts_at >= now()`).

## 16. Removing enrolled member cancels future participation only

- A1 calls `remove_program_member(prog1, M2)` where M2 is `enrolled`. Expect: M2's row ->
  `cancelled`; every future materialized `event_participants` row for M2 under prog1 ->
  `cancelled`; no other event's participant rows touched.

## 17. Past attendance survives removal

- Manually mark a *past* event's `event_participants` row for an enrolled target as
  `attendance_status = 'attended'` (test data setup). Call `remove_program_member` for that
  target. Expect: the past row is untouched (`status` still `confirmed`, `attendance_status`
  unchanged) — only future rows are cancelled.

## 18. Removing a held spot promotes the correct next member

- With prog1 at capacity and at least one member waitlisted, A1 calls `remove_program_member` on
  an `enrolled` (or `offered`) target. Expect: the *oldest* waitlisted member (by `waitlisted_at`)
  is now `offered`, matching the exact FIFO order `get_program_roster`'s own ordering would show.

## 19. Removing a waitlisted member does not promote

- A1 calls `remove_program_member` on a `waitlisted` target (capacity already fully held by
  others). Expect: target -> `cancelled`; no other member's status changes.

## 20. Concurrent member join vs staff add cannot overfill

- With exactly 1 spot free in prog1, fire `join_program` (as some member M6) and
  `add_program_member(prog1, M7)` (as A1) from two parallel connections at effectively the same
  time. Expect: exactly one of M6/M7 lands `enrolled`, the other `waitlisted` — never both
  `enrolled`. Confirm via `verify_phase27d3a.sql` block J (`held_count <= default_capacity`).

## 21. Concurrent generation vs staff removal cannot leave stale rows

- Set up a pending-generation scenario (a schedule rule not yet generated through some future
  date) with an already-`enrolled` target. Fire `generate_program_sessions` (extending through the
  new date) and `remove_program_member` (for that same target) from two parallel connections at
  effectively the same time. Expect: once both calls return, that target has **no** `confirmed`
  `event_participants` row on the newly generated event, regardless of which call actually
  committed first (identical reasoning to Phase 27D1's own generation-vs-leave race — see that
  phase's QA §16 for the full commit-order argument, which applies unchanged here since
  remove_program_member takes the same lock at the same point as leave_program).

## 22. Concurrent staff mutations remain deterministic

- Two admins (or an admin and the creating pro) call `add_program_member` for two *different*
  targets at effectively the same time, with exactly 1 spot free. Expect exactly one lands
  `enrolled`, the other `waitlisted` — never both, never neither.
- Two admins call `remove_program_member` for two different currently-held (enrolled/offered)
  targets at effectively the same time, with exactly one member waitlisted. Expect exactly one
  promotion occurs (the single waitlisted member becomes offered once, not twice) — confirm via
  `verify_phase27d3a.sql` block K (no more than one live offer per program).

## 23. No direct authenticated writes

- Confirm (via `verify_phase27d3a.sql` blocks C and D) that `program_enrollments` and
  `event_participants` still show only `authenticated -> SELECT` — this migration adds no write
  grant to either table. All roster mutations happen exclusively through the three RPCs.

## 24. Correct PUBLIC/anon/authenticated function grants

- Confirm `anon` and `PUBLIC` cannot execute any of the three new RPCs (permission-denied at the
  grant level, before the function body runs). Confirm `authenticated` can execute all three. Run
  `verify_phase27d3a.sql` blocks A, B, F, and G and confirm every expectation stated inline,
  including the email-exposure asymmetry: as A1 (admin), `get_program_roster` rows have non-null
  `email`; as P1 (pro, same program), every row's `email` is `null` even though P1 can otherwise
  fully manage the roster.

## 25. Existing member-facing join/leave/offer flows remain unchanged

- Spot-check `join_program`/`leave_program`/`accept_program_waitlist_offer`/
  `decline_program_waitlist_offer` on a program untouched by this checkpoint's testing (or on
  prog1 after resetting test data) — confirm identical behavior to Phase 27D1/27D2, with no
  regression introduced by this migration reusing their shared private helpers.

## 26. Existing create/update/preview/generate program flows remain unchanged

- Create a fresh draft program, preview it, edit it (while still draft), and generate it — confirm
  identical behavior to Phase 27B2/27C/27D1's own QA, with no regression introduced by this
  migration (0092 does not touch `create_program`, `update_program`, `preview_program_sessions`,
  or `generate_program_sessions` at all — it only adds three new functions).

## Cleanup

Delete all test programs, their generated events/reservations, and test `program_enrollments`/
`event_participants`/`club_memberships`/`audit_log` rows created above before treating the
environment as clean.
