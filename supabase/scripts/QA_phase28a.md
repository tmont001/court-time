# QA — Phase 28A: Reporting Foundation

Manual QA for `supabase/migrations/0095_reporting_foundation.sql` and the accompanying
`/admin/reports` page. Run against a disposable/staging database. Run `verify_phase28a.sql` first
and confirm every block's expectation before starting manual QA.

All dates below are expressed relative to **D = the club-local calendar date you run this QA on**.
Using a fully past, day-of-week-independent range (`D-7` through `D-1`) means the fixture's
expected numbers never depend on which real weekday you run it on, and every fixture event/
reservation in the main week is safely `starts_at <= now()` no matter when you execute this.

## 0. Pre-apply baseline (run BEFORE applying 0095)

`verify_phase28a.sql` blocks D (non-SELECT table grants) and K (policies on the tables this
checkpoint reads) are informational, not pass/fail on their own — several of these tables may
already carry legitimate grants/policies unrelated to this migration. Run both blocks now, against
the database in its pre-0095 state, and save the output somewhere durable. After applying 0095, run
them again (see §13) — the two result sets **must be identical**. 0095 adds no table grant and no
RLS policy anywhere; any difference is a real regression, not an artifact of running the check.

## 1. Fixture setup — Club Q, two active courts, one inactive court, one full past week

Create club **Q1** (any timezone without a DST transition inside `D-7`..`D-1` — e.g.
`America/New_York` is fine outside early March / early November; pick a plain week if unsure).

**Courts**: `CourtA` (`display_order=0`, `is_active=true`), `CourtB` (`display_order=1`,
`is_active=true`), `CourtC` (`display_order=2`, **`is_active=false`**).

**Weekly `operating_hours`**: all 7 `day_of_week` rows, `opens_at=08:00`, `closes_at=20:00`,
`is_closed=false` (12 open hours on every plain weekday, regardless of which real weekday each
fixture day lands on).

**`operating_hours_override`**:
- `Day3` (= `D-5`): `is_closed=true` (fully closed override day → 0 hours, beats the 12h weekly
  default).
- `Day5` (= `D-3`): `is_closed=false`, `opens_at=10:00`, `closes_at=14:00` (special-hours override,
  4 hours, beats the 12h weekly default).
- `Day1,2,4,6,7` (= `D-7,D-6,D-4,D-2,D-1`): no override row → weekly 12h applies.

**Expected daily open hours per court**: `12+12+0+12+4+12+12 = 64` hours over the 7-day range.
Only `CourtA`/`CourtB` are active, so **available_court_hours (overview) = 64 × 2 = 128** — NOT
`× 3`. `available_hours` (per-court) = 64 for each of CourtA and CourtB; `CourtC` must not appear
in `get_court_utilization`'s output at all (§3).

**Reservations** (insert directly via SQL, not `create_reservation`, so past dates are allowed):

| # | Court | Day / time (club-local) | reason | status | Duration |
|---|---|---|---|---|---|
| R1 | A | Day1 09:00–11:00 | member_booking | confirmed | 2h |
| R2 | A | Day4 10:00–12:00 | event | confirmed | 2h |
| R3 | A | Day5 11:00–12:00 | pro_lesson | pending | 1h |
| R4 | A | Day6 08:00–09:00 | maintenance | confirmed | 1h |
| R5 | A | Day7 09:00–10:00 | member_booking | **cancelled** | 1h |
| R6 | A | Day7 23:00 → D 01:00 | member_booking | confirmed | 2h total, **crosses the range's upper boundary** |
| R7 | B | Day2 08:00–10:00 | admin_block | confirmed | 2h |
| R7b | B | Day4 14:00–16:00 | member_booking | confirmed | 2h |
| R8 | B | Day0(=D-8) 23:00 → Day1 01:00 | member_booking | confirmed | 2h total, **starts before the range, overlaps into it** |
| R9 | **C (inactive)** | Day4 09:00–11:00 | member_booking | confirmed | 2h, **must contribute to neither overview nor per-court totals** |

**Events** (report range is `[Day1 00:00, Day7+1 00:00)` local = `[D-7, D-1]` inclusive):

| # | Day | program_id | status | capacity | confirmed participants | guests | notes |
|---|---|---|---|---|---|---|---|
| E1 | Day2 | null (standalone) | scheduled | 6 | 4 | 1 | enrolled = 5 |
| E2 | Day5 | set (generated program session) | scheduled | 10 | 3 | 0 | enrolled = 3; see note below on both `sessions_held` and outstanding-waitlist treatment |
| E3 | Day3 | null | **cancelled** | 4 | — | — | must be excluded from `sessions_held` entirely |
| E5 | D+1 (tomorrow, outside range) | null | scheduled | 5 | — | — | must be excluded — `starts_at` outside `[Day1, Day7+1)` |

E2 also has 1 `waitlisted` `event_participants` row, used in §7 as the "past event — excluded"
outstanding-waitlist case (E2's `sessions_held`/enrollment numbers in §2 are unaffected by that —
this checkpoint's waitlist correction only changes what counts as *outstanding*, not fill rate).

**E2 setup note (Phase 27 linkage constraint):** if you insert E2 directly via SQL, it must satisfy
the all-or-none program linkage constraint from `0087_programs_schema_foundation.sql`
(`events_program_linkage_all_or_none`) — `program_id`, `program_schedule_rule_id`, AND
`program_occurrence_date` must all be set together, referencing a real `program_schedule_rules` row
via the composite FK (`program_schedule_rule_id, program_id`). The simpler and less error-prone
option is to create the owning program and rule via `create_program`, then generate E2 through
`generate_program_sessions` (backdated to Day5) rather than hand-crafting the linkage columns.

**`club_memberships`** on Q1:
- M1, M2: `role='member'`, `status='active'`, `removed_at is null` → **count**.
- M3: `role='member'`, `status='inactive'` → excluded.
- M4: `role='member'`, `status='active'`, `removed_at` set (simulate a removed member whose status
  wasn't flipped) → excluded — proves the query checks `removed_at is null`, not just `status`.
- P1: `role='pro'`, `status='active'` → excluded (role ≠ member).
- A1: `role='admin'`, `status='active'` → excluded (role ≠ member).

## 2. Expected `get_reporting_overview(Day1, Day7)` result

Work through the formulas in `0095_reporting_foundation.sql` against the fixture above:

- Reserved hours (gross), clipped to the range, `status in ('pending','confirmed')`, **active
  courts only** (R9 on inactive CourtC excluded regardless of status/range — confirm it contributes
  **0h**, not 2h):
  CourtA: R1(2) + R2(2) + R3(1) + R4(1) + R6(clipped to 1) = **7h**.
  CourtB: R7(2) + R7b(2) + R8(clipped to 1) = **5h**.
  **gross_reserved_hours = 12h** (unchanged by R9's presence — this is the explicit proof that an
  inactive-court reservation never reaches the total).
- Member-demand hours (`member_booking`/`event`/`pro_lesson` only — R4 maintenance and R7
  admin_block excluded; R9 excluded as above):
  CourtA: R1(2) + R2(2) + R3(1) + R6(1) = 6h. CourtB: R7b(2) + R8(1) = 3h.
  **member_demand_reserved_hours = 9h.**
- `gross_utilization_pct = 12 / 128 * 100 = 9.38` (rounded to 2dp).
- `member_demand_utilization_pct = 9 / 128 * 100 = 7.03`.
- `total_reservations`: reservations whose **starts_at** falls in `[Day1, Day7+1)` — R1, R2, R3,
  R4, R5, R6 (starts Day7 23:00, inside range), R7, R7b, **R9** = **9**. (R9's `starts_at` IS inside
  the range, so it counts here even though it contributed zero reserved hours above — this
  reservation-count field is not court-active-filtered, only the hours totals are. R8 is still
  excluded from this count — its `starts_at` is on Day0, before the range.)
- `cancelled_reservations = 1` (R5 only).
- `cancellation_rate_pct = 1 / 9 * 100 = 11.11`.
- `sessions_held = 2` (E1, E2 — E3 excluded for `status='cancelled'`, E5 excluded for being outside
  the range).
- `total_session_capacity = 6 + 10 = 16`.
- `total_session_enrollment = 5 + 3 = 8` (confirmed participants + guests only; E2's waitlisted row
  excluded).
- `session_fill_rate_pct = 8 / 16 * 100 = 50.00`.
- `active_member_count = 2` (M1, M2 only).
- `outstanding_waitlist_count`: **not** derived from this week's fixture at all — see §7 for its
  dedicated, range-independent fixture and expected value (4).

## 3. Expected `get_court_utilization(Day1, Day7)` result

| court | available_hours | gross_reserved_hours | member_demand_reserved_hours | gross_utilization_pct | member_demand_utilization_pct |
|---|---|---|---|---|---|
| CourtA | 64 | 7 | 6 | 10.94 | 9.38 |
| CourtB | 64 | 5 | 3 | 7.81 | 4.69 |

Confirm row order is CourtA then CourtB (by `display_order`), and confirm **CourtC does not appear
as a row at all** (inactive courts are excluded from this RPC's result set entirely, not just
zeroed out).

## 4. Zero-denominator case

Call both RPCs with `p_start_date = p_end_date = Day3` (the fully closed override day, no
reservations or events fixture-dated on it). Expect: `available_hours = 0`,
`gross_utilization_pct = 0`, `member_demand_utilization_pct = 0` (not an error, not NaN),
`total_reservations = 0`, `cancellation_rate_pct = 0`, `sessions_held = 0` (E3 is excluded anyway
for being cancelled), `total_session_capacity = 0`, `session_fill_rate_pct = 0`.

## 5. Boundary/clipping/active-court checks

- Confirm R6 (Day7 23:00 → D 01:00) contributes exactly **1 hour**, not 2, to both CourtA's
  `gross_reserved_hours` and the overview total — proves clipping against the range's **upper**
  bound.
- Confirm R8 (Day0 23:00 → Day1 01:00) contributes exactly **1 hour**, not 2, to CourtB's
  `gross_reserved_hours` — proves clipping against the range's **lower** bound, and proves overlap
  detection includes a reservation whose `starts_at` is before the range entirely.
- Confirm R8 does **not** appear in `total_reservations`/`cancelled_reservations` (see §2) — proves
  those two fields use `starts_at`-in-range, not overlap.
- Confirm R9 (on inactive CourtC) contributes **0h** to every hours-based field in both RPCs, while
  still counting toward `total_reservations` (see §2) — proves the active-court join in
  `_reporting_reserved_hours` is scoped to the hours calculation, not the reservation-count query.
- Confirm `available_court_hours` (overview) is `128`, not `192` — proves CourtC's existence does
  not inflate the active-court multiplier.

## 6. Operating-hours precedence edge case (malformed override fallback)

This isolated check is deliberately **outside** the Day1–Day7 range so it doesn't disturb the
arithmetic above. On Q1, pick an unused date `DayX` (e.g. `D+10`) whose weekly `operating_hours` row
is open (e.g. 08:00–20:00, 12h, same as the rest of the fixture). Insert an
`operating_hours_override` row for `DayX` with `is_closed=false` and **`opens_at`/`closes_at` both
NULL** — a malformed row the real `upsert_operating_hours_override` RPC (0045) can never produce
(it requires both whenever `is_closed=false`), but which direct SQL can create for this test.

Call `get_court_utilization(DayX, DayX)` (or the overview RPC). Expect `available_hours = 12` —
falling back to the weekly hours row, exactly as the Calendar's own precedence contract requires.
Before this checkpoint's fix, this case incorrectly returned `0`. Confirm the result is **not** 0.

## 7. Outstanding waitlist — dedicated fixture (range-independent)

`outstanding_waitlist_count` is a live snapshot based on real `now()`, not the report range — build
this fixture using offsets from **today** (not from Day1–Day7). `F` = a date a few days in the
future (e.g. `D+5`); `Y` = yesterday (`D-1`).

**Events:**

| # | starts_at | status | archived_at | participant rows | expected |
|---|---|---|---|---|---|
| EW1 | F (future) | scheduled | null | 1 `waitlisted` | **counts** |
| EW1b | F (future, can reuse EW1) | scheduled | null | 1 `offered`, `offer_expires_at = now()+2h` | **counts** |
| EW2 | F (future, can reuse EW1) | scheduled | null | 1 `offered`, `offer_expires_at = now()-2h` | excluded — expired |
| E2 (from §1) | Day5 (past) | scheduled | null | 1 `waitlisted` | excluded — event is past (`starts_at` not `> now()`) |
| EW4 | F (future) | **cancelled** | null | 1 `waitlisted` | excluded — `status <> 'scheduled'` |
| EW5 | F (future) | scheduled | **set** | 1 `waitlisted` | excluded — `archived_at is not null` |

Event-side outstanding count = **2** (EW1 + EW1b).

**Programs** (whole-program enrollment only — no generated events needed for these):

| # | enrollment_model | status | archived_at | ends_on | enrollment rows | expected |
|---|---|---|---|---|---|---|
| PW1 | program | active | null | today + 30 | 1 `waitlisted` | **counts** |
| PW1b | program | active | null | today + 30 (reuse PW1) | 1 `offered`, `offer_expires_at = now()+2h` | **counts** |
| PW2 | program | active | null | today + 30 (reuse PW1) | 1 `offered`, `offer_expires_at = now()-2h` | excluded — expired |
| PW3 | program | **cancelled** | null | today + 30 | 1 `waitlisted` | excluded — `status <> 'active'` |
| PW4 | program | **completed** | null | today + 30 | 1 `waitlisted` | excluded — `status <> 'active'` |
| PW5 | program | cancelled, then **archived** | set | today + 30 | 1 `waitlisted` | excluded (doubly — `status` and `archived_at`; a program can only be archived after cancel/complete, so this case can't independently isolate the `archived_at` filter, but is included for completeness) |
| PW6 | program | active | null | **`Y` (yesterday)** | 1 `waitlisted` | excluded — `ends_on < ` club-local today |
| PW7 | **per_session** | active | null | today + 30 | 1 `waitlisted` (inserted directly — `join_program`'s normal flow wouldn't produce this for a non-`program` model) | excluded — `enrollment_model <> 'program'` |

Program-side outstanding count = **2** (PW1 + PW1b).

**Expected `outstanding_waitlist_count = 4`** (2 event-side + 2 program-side). Confirm each excluded
row individually by temporarily removing the others and re-checking the count changes only when
expected — this catches an accidentally-too-loose `or` condition that a single combined count could
mask.

**Club-local "today" derivation:** confirm `PW6`'s exclusion specifically uses `clubs.timezone` for
Q1, not the database session's timezone — set Q1's timezone to something other than the database
server's default (e.g. `Pacific/Auckland` if your server defaults to UTC or US-based) and confirm
`ends_on = Y` is still correctly evaluated as "ended" using Q1's own local calendar, not the
session's.

## 8. DST correctness (separate, qualitative check)

Pick a club timezone and a custom range that spans a real DST transition (e.g. `America/New_York`,
`p_start_date` a few days before the US spring-forward date, `p_end_date` a few days after). Add
one weekly-hours-only day (no override) on the transition date itself. Confirm:
- The transition date still contributes the correct **wall-clock** hour count (`closes_at -
  opens_at`, e.g. 12h) to `available_hours` — daily hours are wall-clock durations and are not
  themselves affected by DST.
- A reservation whose `starts_at`/`ends_at` straddles local midnight on the transition date is
  clipped against the correct **UTC instant** of that local midnight (23-hour or 25-hour day) —
  cross-check by converting the boundary to UTC by hand (or via `getZonedDayBoundsUTC` in a scratch
  script) and confirming it matches what `club_local_bounds` produced.

## 9. Authorization

- A **member** (role='member') calls `get_reporting_overview`/`get_court_utilization`. Expect
  `insufficient_role` from both.
- A **pro** calls both. Expect `insufficient_role` from both (admin-only in 28A).
- A user with **no active club membership** (e.g. `active_club_id` null, or membership
  `status='inactive'`) calls both. Expect `not_authenticated` from both.
- An **admin of a second club (Q2)**, seeded with its own courts/reservations/events, calls both
  RPCs. Expect results reflecting **only Q2's data** — zero visibility into any Q1 fixture row
  above. This is the cross-club isolation proof; run it explicitly, don't just infer it from the
  `current_user_club_id()` source-text check in `verify_phase28a.sql` block F.
- Confirm neither RPC accepts or is affected by a `p_club_id`-shaped argument — there is none in
  either signature (`verify_phase28a.sql` block G).

## 10. Date validation

- Call `get_reporting_overview(Day7, Day1)` (end before start). Expect `invalid_date_range`.
- Call with either date `null`. Expect `invalid_date_range`.
- Call with a range spanning 367+ inclusive days. Expect `date_range_too_large`.
- Call with a range spanning exactly 366 inclusive days. Expect success (boundary is inclusive of
  366, exclusive of 367+).

## 11. Frontend — `/admin/reports`

- Visit `/admin/reports` as a **member**. Expect redirect (the route itself gates on the
  membership-native active-club role — not just a hidden nav entry).
- Visit as a **pro**. Expect redirect (28A is admin-only).
- Visit as an **admin**. Confirm default range is `7d`, KPI tiles and the per-court section render
  using the Q1 fixture numbers computed above.
- Switch to `today` and `30d` via the preset pills.
- **Custom range control**: confirm a visible form (start date, end date, Apply) renders alongside
  the preset pills. Submit `start=Day1&end=Day7`; confirm it navigates to
  `/admin/reports?range=custom&start=<Day1>&end=<Day7>` and reproduces the exact numbers in §2–§3.
  Confirm the start/end inputs remain populated with those values after the page reloads (not
  cleared). Confirm the custom form is visually marked as the active selection instead of any preset
  pill.
- Submit an invalid custom range (end before start, or missing a field). Confirm a stable validation
  message renders, the page falls back to the 7d numbers, and no raw RPC error text appears. Confirm
  the 366-day maximum is still enforced (submit a >366-day custom range and confirm the same
  fallback message, not a raw Postgres error).
- **Timezone failure**: temporarily make the club timezone lookup fail or return no row (e.g. point
  `profile.activeClubId` at a nonexistent club id in a scratch test, or temporarily null out
  `clubs.timezone` for Q1). Confirm the page renders the Header plus a single stable "Reports are
  temporarily unavailable" message, makes **no** call to either reporting RPC (check network/logs),
  and does not display any raw Supabase error text or stack trace.
- Temporarily revoke `authenticated`'s EXECUTE on one RPC (with a valid timezone) and confirm that
  section shows a stable "unavailable" state while the other section still renders — per-section
  failure isolation, matching `/admin/overview`'s existing pattern. This is distinct from the
  timezone-failure case above, which stops the whole page before either RPC is called.
- Confirm the page's disclaimer text names **both** the active-court configuration and the
  operating-hours configuration as current-only (not historical), and that Active Members /
  Outstanding Waitlist / Today are labeled as described in §7 and elsewhere above.
- Confirm no chart library was installed (`package.json` unchanged in that respect) and no section
  fetches or renders an unbounded raw row list.

## 12. Regression

- Confirm `/admin/overview`, `/calendar`, `/events`, program rosters, and `/admin/lessons` are
  visually and functionally unchanged — this checkpoint is additive-only.
- Confirm `SideNav.tsx`'s pro branch does **not** gain a Reports link.

## 13. Post-apply grant/policy diff

Re-run `verify_phase28a.sql` blocks D and K now that 0095 is applied. Diff both results against the
pre-apply baseline from §0. They must be identical — any new, missing, or altered row is a real
regression to investigate before treating this checkpoint as verified.

## Cleanup

Delete all Q1/Q2 fixture data (courts including CourtC, operating hours/overrides including the
`DayX` malformed row, reservations, events including EW1/EW1b/EW2/EW4/EW5, event_participants,
event_guests, programs including PW1–PW7, program_enrollments, club_memberships, and the clubs
themselves) before treating the environment as clean.
