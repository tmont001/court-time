# QA — Phase 28B: Operational Reporting Sections

Manual QA for `supabase/migrations/0096_reporting_sections.sql` and the four new sections on
`/admin/reports`. Run against a disposable/staging database with 0095 and 0096 applied. Run
`verify_phase28b.sql` first and confirm every block's expectation before starting manual QA.

Dates below reuse the same convention as `QA_phase28a.md`: **D = the club-local calendar date you
run this QA on**, `Day1..Day7 = D-7..D-1` (a full past week, day-of-week-independent), `F` = a few
days in the future (e.g. `D+5`), `Y` = yesterday (`D-1`). This checkpoint's RPCs reuse 0095's
`club_local_bounds()` unchanged, so the range/boundary/DST correctness already proven in
`QA_phase28a.md` §5/§6/§8 is not re-derived here — this fixture focuses on what's new.

## 0. Fixture isolation — four separate disposable clubs

Each RPC's expected numbers below are hand-computed against a fixture designed to exercise that
RPC only. If two fixtures shared a club, one RPC's data would leak into another's expected totals
(e.g. a member-engagement reservation would inflate the reservation-summary count on the same
club) — every prior draft of this doc had exactly that problem.

**Use four separate disposable clubs, one per fixture, and never mix rows across them:**

- **Club `Q_R`** — Fixture R, for `get_reservation_summary` (§1–§2).
- **Club `Q_E`** — Fixture E, for `get_event_program_summary` (§3–§4).
- **Club `Q_W`** — Fixture W, for `get_waitlist_demand` (§5–§6).
- **Club `Q_M`** — Fixture M, for `get_member_engagement_summary` (§7–§8).

If you'd rather reuse a single club across fixtures instead of creating four, you must fully
delete every row from the previous fixture (reservations, events, participants, guests,
enrollments, and any club_memberships beyond the admin you're testing as) before seeding the next
one, and re-run `verify_phase28b.sql` block M (policy snapshot) is unaffected either way since it
doesn't depend on fixture data. Separate clubs are simpler and strongly recommended — RPC scoping
via `current_user_club_id()` makes cross-club leakage structurally impossible, so isolation is
free.

Each club needs, at minimum: one admin profile (to call the RPCs), the courts/event_types rows
its own fixture requires, and its own `club_settings`/`operating_hours` if you want the club to be
usable in the calendar UI (not required for these RPCs, which don't touch operating hours).

## 1. Fixture R (Club `Q_R`) — reservations only

One court, one member profile to own all reservations (the owner's identity doesn't affect this
RPC's output).

| Day | Reservations |
|---|---|
| Day1 | 2× `member_booking` confirmed, 1× `member_booking` cancelled |
| Day2 | 1× `event` confirmed |
| Day3 | *(none — zero-count day, mid-range)* |
| Day4 | 1× `pro_lesson` pending, 1× `maintenance` confirmed |
| Day5 | 1× `admin_block` confirmed |
| Day6 | 1× `member_booking` confirmed, 1× `member_booking` cancelled |
| Day7 | *(none — zero-count day, end of range)* |

No other reservations exist on `Q_R`. Court/active-status doesn't matter for this RPC — unlike
0095's utilization RPCs, `get_reservation_summary` counts booking activity regardless of whether
the court is currently active (documented in the migration's comment header).

## 2. Expected `get_reservation_summary(Day1, Day7)` on `Q_R`

- `total_reservations = 9` (3+1+0+2+1+2+0 across the week).
- `pending_reservations = 1` (the Day4 pro_lesson).
- `confirmed_reservations = 6`.
- `cancelled_reservations = 2` (Day1 + Day6).
- `cancellation_rate_pct = 2 / 9 * 100 = 22.22`.
- `member_booking_count = 5` (3 on Day1 + 2 on Day6).
- `event_count = 1`, `pro_lesson_count = 1`, `maintenance_count = 1`, `admin_block_count = 1`.
- `daily_series` — exactly 7 elements: `Day1: {total:3, cancelled:1}`, `Day2: {total:1,
  cancelled:0}`, `Day3: {total:0, cancelled:0}`, `Day4: {total:2, cancelled:0}`, `Day5: {total:1,
  cancelled:0}`, `Day6: {total:2, cancelled:1}`, `Day7: {total:0, cancelled:0}`. Confirm `Day3`
  and `Day7` are present with `total_count: 0` — not missing from the array. See §14 for the
  dedicated array-ordering assertion.

## 3. Fixture E (Club `Q_E`) — events & programs only

No reservations, waitlist rows, or club_memberships beyond the admin are needed on `Q_E`.

**Held** (status='scheduled', starts_at ≤ now(), inside `Day1`–`Day7`):
- `ES1` (standalone, `program_id` null), Day2, capacity 6: 3 confirmed participants (2
  `attended`, 1 `no_show`) + 1 `waitlisted` participant (must be excluded from every count) + 2
  guests.
- `ES2` (standalone), Day4, capacity 4: 2 confirmed participants, **both `attendance_status`
  null** (unmarked — must be excluded from `attendance_marked_count` and both rate denominators).
- `EP1` (program-generated, `program_id` set — satisfy the Phase 27 all-or-none linkage
  constraint, or create via `generate_program_sessions`), Day5, capacity 8: 4 confirmed
  participants (3 `attended`, 0 `no_show`, 1 unmarked) + 1 guest.

**Cancelled** (status='cancelled', starts_at inside `Day1`–`Day7` — a separate count, never
counted as "held"):
- `ESc1` (standalone), Day3, capacity 5.
- `EPc1` (program-generated), Day6, capacity 10.

## 4. Expected `get_event_program_summary(Day1, Day7)` on `Q_E`

- `standalone_sessions_held = 2` (ES1, ES2), `program_sessions_held = 1` (EP1),
  `total_sessions_held = 3`.
- `total_capacity = 6 + 4 + 8 = 18`.
- `confirmed_members = 3 + 2 + 4 = 9` (ES1's waitlisted participant excluded).
- `guests = 2 + 0 + 1 = 3`.
- `total_enrollment = 12`; `fill_rate_pct = 12 / 18 * 100 = 66.67`.
- `attended_count = 5` (ES1: 2, EP1: 3), `no_show_count = 1` (ES1: 1).
- `attendance_marked_count = 6` — confirm this is **not** 9: ES2's 2 unmarked confirmed
  participants and EP1's 1 unmarked confirmed participant must be excluded from both the
  numerator and denominator, not just the numerator.
- `attendance_rate_pct = 5 / 6 * 100 = 83.33`; `no_show_rate_pct = 1 / 6 * 100 = 16.67`.
- `cancelled_standalone_sessions = 1` (ESc1); `cancelled_program_sessions = 1` (EPc1) — confirm
  neither ESc1 nor EPc1 contributes to `total_sessions_held` or `total_capacity`.

## 5. Fixture W (Club `Q_W`) — waitlist only, range-independent

No reservations or event/program-summary data are needed on `Q_W`. This is a live snapshot, so
dates below are relative to real `now()`, not `Day1`–`Day7`.

**Events:**
- `WE1`: `F` (future), `scheduled`, `archived_at` null — 2 `waitlisted` participants + 1 `offered`
  with `offer_expires_at = now()+2h` (live).
- `WE2`: `F`, `scheduled`, not archived — 1 `offered` with `offer_expires_at = now()-2h` (expired
  — excluded).
- `WE3`: `Day2` (past), `scheduled` — 1 `waitlisted` (excluded — not future).
- `WE4`: `F`, **`cancelled`** — 1 `waitlisted` (excluded — not scheduled).
- `WE5`: `F`, `scheduled`, **archived** — 1 `waitlisted` (excluded — archived).

**Programs** (whole-program enrollment; no generated events needed):
- `WP1`: `enrollment_model='program'`, `status='active'`, not archived, `ends_on = today+30` — 2
  `waitlisted` + 1 `offered` with `offer_expires_at = now()+2h` (live).
- `WP2`: same shape as WP1 — 1 `offered` with `offer_expires_at = now()-2h` (expired — excluded).
- `WP3`: `status='cancelled'` — 1 `waitlisted` (excluded).
- `WP4`: `status='completed'` — 1 `waitlisted` (excluded).
- `WP5`: `status='active'`, `ends_on = Y` (yesterday) — 1 `waitlisted` (excluded — ended).
- `WP6`: `enrollment_model='per_session'`, `status='active'`, `ends_on = today+30` — 1
  `waitlisted` (excluded — wrong model; insert directly since the normal join flow wouldn't
  produce this for a non-`program` model).

## 6. Expected `get_waitlist_demand(Day1, Day7)` on `Q_W`

The date arguments are validated but never filter these fields (see §12).

- `event_waitlisted_entries = 2` (WE1's two waitlisted rows).
- `event_live_offer_entries = 1` (WE1's one live offer).
- `program_waitlisted_entries = 2` (WP1's two waitlisted rows).
- `program_live_offer_entries = 1` (WP1's one live offer).
- `total_outstanding_entries = 2 + 1 + 2 + 1 = 6`.

Individually confirm each excluded row (WE2 expired, WE3 past, WE4 cancelled, WE5 archived, WP2
expired, WP3 cancelled, WP4 completed, WP5 ended, WP6 wrong model) by removing the others and
re-checking the count changes only when expected.

## 7. Fixture M (Club `Q_M`) — member engagement only

One court and one event_types row (for `EM1`/`EM2`), no other clubs' reservations/events/programs
are needed. All members below are `role='member'`, `status='active'`, `removed_at is null` unless
noted.

**Events:** `EM1` (Day4, any standalone event — this RPC doesn't require `status='scheduled'` or
`starts_at <= now()`, only `starts_at` in range and a confirmed participant); `EM2` (Day5, same
shape).

**Programs:** `PGM1` (`enrollment_model='program'`, window `starts_on=Day-3, ends_on=Day10` —
overlaps `Day1`–`Day7`); `PGM2` (`enrollment_model='program'`, window `starts_on=D+10,
ends_on=D+20` — does **not** overlap); `PGM3` (**`enrollment_model='per_session'`**, window
`starts_on=Day-3, ends_on=Day10` — overlaps, same as PGM1, so only the model differs).

**Members:**
- `M1`: 1 confirmed `member_booking` reservation on Day2.
- `M2`: 1 confirmed participation on `EM1` (Day4).
- `M3`: 1 `program_enrollments` row, `status='enrolled'`, on `PGM1` (whole-program, overlapping
  window).
- `M4`: **both** a confirmed reservation (Day3) **and** confirmed participation on `EM2` (Day5) —
  the double-activity case.
- `M5`: no qualifying activity at all.
- `M7`: 1 confirmed reservation dated `Day-10` — **outside** the range (excluded from
  `members_with_reservations`, proving the range filter).
- `M8`: 1 `program_enrollments` row, `status='enrolled'`, on `PGM2` (non-overlapping window —
  excluded, proving the overlap filter).
- `M9`: 1 `program_enrollments` row, `status='waitlisted'` (not `enrolled`), on `PGM1` (excluded,
  proving the status filter).
- `M10`: 1 `program_enrollments` row, `status='enrolled'`, on **`PGM3`** (per_session model,
  otherwise identical overlapping window to PGM1) — **excluded, proving the
  `enrollment_model='program'` restriction added in this correction.** Insert this row directly;
  the normal enrollment flow wouldn't produce it for a non-`program` model.
- `M6`: `status='inactive'`, with a confirmed reservation on Day2 (excluded from everything,
  including the active-member snapshot).
- `Pro1`: `role='pro'`, `status='active'`, with a confirmed reservation on Day2 (excluded — role
  filter, despite genuine activity).
- `Admin1`: `role='admin'`, `status='active'`, with confirmed participation on `EM1` (Day4)
  (excluded — role filter).

An unclaimed `roster_members` row is not fixtured separately: a roster member has no `profiles`
row, and `reservations.owner_user_id`/`event_participants.profile_id`/
`program_enrollments.profile_id` all FK into `profiles(id)` — an unclaimed roster member cannot
own a reservation or hold a participation/enrollment row at all. Exclusion here is structural.

## 8. Expected `get_member_engagement_summary(Day1, Day7)` on `Q_M`

- `active_member_snapshot_count = 9` (M1, M2, M3, M4, M5, M7, M8, M9, M10 — M6/Pro1/Admin1
  excluded by role/status).
- `members_with_reservations = 2` (M1, M4 — M7 excluded for being outside the range, M6/Pro1
  excluded for role/status despite real activity).
- `members_with_event_participation = 2` (M2, M4 — Admin1 excluded for role despite real
  activity).
- `members_with_program_enrollment = 1` (M3 — M8 excluded for non-overlapping window, M9 excluded
  for wrong status, **M10 excluded for wrong enrollment_model**). Confirm this is `1`, not `2` —
  before this correction, M10 would have incorrectly inflated this to `2`.
- `engaged_member_count = 4` — the distinct union `{M1, M2, M3, M4}`. Confirm this is **not** `5`
  (the naive sum of `2 + 2 + 1`) — M4 must be counted once despite appearing in both the
  reservations and event-participation sources.

## 9. Empty-data / zero-denominator case

On a freshly seeded fifth club with zero reservations, events, participants, guests, waitlist
rows, and enrollments, call all four RPCs for any valid range. Expect: every count is `0`, every
percentage is `0` (never an error, never `NaN`), and `get_reservation_summary`'s `daily_series` is
still a fully zero-filled array with one element per day in the requested range (e.g. `7` elements
for a 7-day range, each `{total_count: 0, cancelled_count: 0}`) — not an empty array.

## 10. Cross-club isolation

Applies uniformly to all four RPCs; run once using any one fixture club (Fixture M's `Q_M` is
recommended — it has the richest data) paired with a second, freshly seeded club `Q2` carrying its
own distinct reservations/events/waitlist/membership rows. An admin of `Q2` calling all four RPCs
must see **only** `Q2`'s numbers — zero visibility into any `Q_M` (or `Q_R`/`Q_E`/`Q_W`) fixture
data. Run this explicitly; don't infer it from the `current_user_club_id()` source-text check in
`verify_phase28b.sql` block E alone.

## 11. Authorization

- A **member** calls each of the four RPCs. Expect `insufficient_role` from all four.
- A **pro** calls each. Expect `insufficient_role` from all four (28B stays admin-only, matching
  28A).
- A user with no active club membership calls each. Expect `not_authenticated` from all four.
- Confirm none of the four accepts or is affected by a `p_club_id`-shaped argument
  (`verify_phase28b.sql` block F).

## 12. Date validation (reused from 0095, re-verified per RPC)

- Call each of the four RPCs with `p_end_date` before `p_start_date`. Expect `invalid_date_range`
  from all four, including `get_waitlist_demand` — its snapshot fields don't depend on the range,
  but the range is still validated before any data is returned (confirms the `perform
  club_local_bounds(...)` call is not skipped or short-circuited).
- Call each with a range spanning 367+ inclusive days. Expect `date_range_too_large` from all
  four.

## 13. Range crossing club-local midnight / DST

`get_reservation_summary` is the only 28B RPC that buckets by club-local calendar date on its own
(via `(starts_at at time zone v_tz)::date`), so it's the one most worth re-checking here even
though `club_local_bounds` itself was already proven DST-safe in `QA_phase28a.md` §8. Run this
against `Q_R` (or a scratch copy of it):

- Insert two reservations straddling a local-midnight boundary within the range — one at `Day3
  23:45` local and one at `Day4 00:15` local. Confirm they land in `Day3`'s and `Day4`'s
  `daily_series` buckets respectively, not both in the same bucket and not shifted by a day.
- Repeat the custom-range DST scenario from `QA_phase28a.md` §8 (a range spanning a real
  spring-forward or fall-back date) and confirm `daily_series` still produces exactly the right
  number of calendar-date buckets across the transition, and that a reservation placed just
  before/after the transition's local midnight lands in the correct bucket.

## 14. Daily-series chronological ordering (dedicated assertion)

This is distinct from §2's "all dates present" check — it asserts the **array order itself**.

- Call `get_reservation_summary(Day1, Day7)` on `Q_R` and inspect the raw `daily_series` JSON
  array as returned (not re-sorted by any client code). Confirm element `[0].local_date = Day1`,
  `[1].local_date = Day2`, `[2].local_date = Day3`, … `[6].local_date = Day7` — the array is
  chronologically ordered as returned by the RPC itself.
- Confirm this via `verify_phase28b.sql` block K, which proves `jsonb_agg` carries its own `order
  by s.local_date` in the stored function definition (not dependent on the `series` CTE's own,
  unenforced ordering). The frontend's `DailyBarSeries`
  component renders bars in array order with no client-side sort — if block K ever regresses (the
  `order by` is dropped from `jsonb_agg`), this manual check is what would catch a
  Postgres-version-dependent case where CTE order happened to "accidentally" survive during
  development but isn't guaranteed.
- As a stronger proof, re-run the same call several times, ideally after `ANALYZE reservations;`
  or on a connection with a different `work_mem`/parallelism setting if you can arrange it — the
  order must remain stable regardless of the query planner's chosen execution path, which is
  exactly what an explicit `ORDER BY` inside `jsonb_agg` (and not a CTE's own `ORDER BY`)
  guarantees and a plan-dependent ordering would not.

## 15. Frontend — `/admin/reports`

- Visit as admin with Fixture R active (or any club with a `7d`/custom range matching a seeded
  week) and confirm all four new sections (Reservations, Events & Programs, Waitlist Demand,
  Member Engagement) render below Court Utilization.
- Confirm the Reservations section's daily bar chart shows 7 bars in left-to-right chronological
  order, including visibly empty (zero-height) bars for zero-count days.
- Confirm the required disclaimer text is present: Waitlist Demand labeled a current snapshot
  independent of the selected range; the Events & Programs attendance-rate note states rates are
  based only on participants with a recorded attendance mark; the Member Engagement note states
  figures are distinct active members, not total actions, and clarifies program sessions are
  generated events, not a separate table.
- Temporarily revoke `authenticated`'s EXECUTE on exactly one of the four new RPCs. Confirm only
  that section shows the stable "Data unavailable" state while the other three new sections (and
  the existing KPI/utilization sections) still render normally.
- Confirm no raw RPC/Postgres error text appears anywhere on the page under any failure condition
  tested above or in `QA_phase28a.md` (timezone failure, invalid custom range).
- Confirm no chart library was installed (`package.json` unchanged in that respect).

## 16. Regression

- Confirm the existing Key Metrics, Court Utilization (overall), and Court Utilization (by court)
  sections from Phase 28A are unchanged in numbers and layout.
- Confirm `/admin/overview`, `/calendar`, `/events`, program rosters, and `/admin/lessons` remain
  unaffected.
- Confirm `SideNav.tsx` is untouched (no new nav entry was needed for 28B).

## 17. Policy baseline verification

`verify_phase28b.sql` block M is an informational snapshot of every policy on the tables 0096
reads (`reservations, events, event_participants, event_guests, club_memberships,
program_enrollments, programs, clubs`) — **not** a claim that the result must be empty. 0096 adds
no table and alters no RLS policy anywhere.

Run block M now, with 0096 applied. Compare it against the pre-0095/0096 baseline you saved per
`QA_phase28a.md` §0 ("Pre-apply baseline"). **The two results must be identical.** Any new,
missing, or altered row is the real regression signal — if you did not save that earlier baseline,
treat this run as the new baseline for any future reporting checkpoint, and note that gap rather
than silently treating an unverified snapshot as proof of no change.

## Cleanup

Delete all fixture data and the four (or five, including the cross-club/empty-data clubs) disposable
clubs — `Q_R`, `Q_E`, `Q_W`, `Q_M`, and any `Q2`/empty-data scratch club — including their courts,
event_types, reservations, events, participants, guests, programs, program_enrollments, and
club_memberships, before treating the environment as clean.
