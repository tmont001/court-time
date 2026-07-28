# Phase 27B2 QA Checklist — Program Definition and Session Generation RPCs

Covers Phase 27B2 in full: migration `0088_program_definition_and_generation_rpcs.sql`
(the original three RPCs) AND the corrective migration
`0089_program_generation_hardening.sql` (ownership preservation,
overlapping-rule rejection, definition revalidation, malformed-JSON
hardening). Requires `0087_programs_schema_foundation.sql` already applied.
0088 is already applied to production and immutable; 0089 only replaces the
three functions' bodies under their existing signatures plus adds one new
private helper (`_validate_program_definition`) — no application-facing
contract change.

**Scope reminder:** still only three callable RPCs — `create_program`,
`preview_program_sessions`, `generate_program_sessions`. There is still no
UI, no member enrollment, no waitlist/offer for programs, and generated
events get zero `event_participants` rows (no host, no materialization —
that's Phase 27C). Every check below is either a direct RPC call (via the
browser console, a REST client, or a throwaway script using a real user's
session) or a plain read-only SQL query against the resulting rows.

Run `supabase/scripts/verify_phase27b2.sql` Sections A–C first — every check
there is signature/grant/body inspection and needs no live session. Section D
of that file is the condensed reference for the functional tests spelled out
in full below.

---

## Pre-conditions

- [ ] Migrations `0087`, `0088`, and `0089` all applied
- [ ] `verify_phase27b2.sql` Sections A–C return the expected rows
- [ ] Staging/test project, not production
- [ ] At least one club with: an active event_type, at least 2 active courts,
      one Admin, one Pro, one Member

---

## create_program

### 27B2-1: Happy path — Admin creates a per_session program

- [ ] As Admin, call:
  ```
  create_program(
    p_event_type_id, 'QA Clinic', 'per_session',
    '<starts_on>', '<ends_on>', 6,
    '[{"day_of_week": 2, "start_time": "09:00", "duration_minutes": 60, "court_ids": ["<court id>"]}]'
  )
  ```
- [ ] Confirm success, returned row has `status = 'draft'`
- [ ] Confirm `program_schedule_rules` has exactly one row for this program,
      `program_rule_courts` has exactly one row for that rule
- [ ] Confirm an `audit_log` row exists: `action = 'create_program'`,
      `target_type = 'program'`, `target_id` = the new program's id

### 27B2-2: Multi-rule, multi-court program

- [ ] Create a program with two rules (e.g. Tue 09:00 and Thu 18:00), each
      with two different courts
- [ ] Confirm 2 `program_schedule_rules` rows and 4 `program_rule_courts`
      rows (2 courts × 2 rules)

### 27B2-3: Validation rejections (each independently, each expects the
program row count to stay at 0 for that attempt)

- [ ] Blank title → `invalid_title`
- [ ] `enrollment_model = 'nonsense'` → `invalid_enrollment_model`
- [ ] `ends_on < starts_on` → `invalid_date_range`
- [ ] Range > 26 weeks (183+ days) → `range_too_long`
- [ ] `default_capacity = 0` → `invalid_capacity`
- [ ] `event_type_id` belonging to a **different club** → `event_type_not_found`
- [ ] An **inactive** event_type in the same club → `event_type_not_found`
- [ ] Empty `p_rules` array → `invalid_rules_payload`
- [ ] Rule with `day_of_week = 7` → `invalid_day_of_week`
- [ ] Rule with `duration_minutes = 0` → `invalid_duration`
- [ ] Rule with `court_ids: []` → `rule_requires_court`
- [ ] Rule with duplicate court in `court_ids` → `duplicate_court_in_rule`
- [ ] Rule referencing a court from **another club** → `court_not_found`
- [ ] Rule referencing an **inactive** court in the same club → `court_not_found`
- [ ] Two rules with the same `day_of_week` + `start_time` → `duplicate_rule`
- [ ] `enrollment_model = 'program'` with any rule's `capacity_override` set
      → `capacity_override_not_allowed_for_program_enrollment`
- [ ] Confirm **none** of the above left a `programs`, `program_schedule_rules`,
      or `program_rule_courts` row behind

### 27B2-4: Role enforcement

- [ ] As a Member, call `create_program` with otherwise-valid input →
      `insufficient_role`
- [ ] As a Pro, call `create_program` → succeeds, `created_by` = that Pro's id

---

## preview_program_sessions

### 27B2-5: Preview shape and content

- [ ] Preview the program from 27B2-1 (no date bounds)
- [ ] Confirm one row per (rule, date, court) combination in the program's
      full `starts_on..ends_on` range
- [ ] Confirm `already_generated = false` for every row (nothing generated
      yet)
- [ ] Confirm `has_conflict = false` for every row (assuming no pre-existing
      reservations on those courts/times)
- [ ] Confirm `starts_at`/`ends_at` match the rule's `start_time` +
      `duration_minutes` in the club's local timezone

### 27B2-6: Bounded preview

- [ ] Preview with `p_from_date`/`p_through_date` narrower than the
      program's range
- [ ] Confirm only occurrences inside the intersection of the requested
      window and the program's own range are returned

### 27B2-7: already_generated after a partial generate

- [ ] Generate sessions for the program (see below), then preview again
- [ ] Confirm every row for an already-generated (rule, date) shows
      `already_generated = true` and `has_conflict = false` — even though a
      reservation now exists at that exact court/time (the program's own)

### 27B2-8: Read-only

- [ ] After any preview call, confirm no new row exists anywhere (`events`,
      `reservations`, `program_schedule_rules`, `program_rule_courts`,
      `audit_log`) as a result of the preview itself

---

## generate_program_sessions

### 27B2-9: Happy path generation

- [ ] Call `generate_program_sessions` on the program from 27B2-1, **as the
      same Admin who created it** (ownership is not interesting in this
      test — see 27B2-19 for the Admin-generates-Pro-program case)
- [ ] Confirm the returned `inserted_count` matches the number of
      (rule, date) slots in the program's range, `skipped_count = 0`,
      `event_ids` has that many entries
- [ ] Confirm each returned event id has: `program_id`, `program_schedule_rule_id`,
      `program_occurrence_date` all set, `is_program_exception = false`,
      `member_joinable = true` (per_session model), `status = 'scheduled'`,
      `created_by` = the program's `created_by` (the Admin, in this case —
      since creator and invoker are the same person here, this test alone
      does not distinguish ownership-preserved from invoker-stamped; see
      27B2-19)
- [ ] Confirm each event has exactly one `reservations` row per assigned
      court, `reason = 'event'`, `status = 'confirmed'`, `event_id` set,
      `owner_user_id` and `created_by` both = the program's `created_by`
- [ ] Confirm **zero** `event_participants` rows exist for any generated
      event (no host row — matches current `create_event` behavior)
- [ ] Confirm the program's `status` transitioned from `draft` to `active`
- [ ] Confirm an `audit_log` row: `action = 'generate_program_sessions'`,
      `actor_id` = the calling Admin's id, metadata includes
      `inserted_count`/`skipped_count`/`from`/`through`/`program_owner_id`/
      `generated_by_id`

### 27B2-10: member_joinable per enrollment model

- [ ] Create and generate one program per enrollment model
      (`per_session`, `program`, `admin_managed`)
- [ ] Confirm generated events' `member_joinable`: `true` for `per_session`,
      `false` for `program`, `false` for `admin_managed`
- [ ] As a Member, attempt `join_event` on an `admin_managed` program's
      generated event → rejected (existing `join_event` `member_joinable`
      guard, unmodified)

### 27B2-11: Idempotent overlapping generation

- [ ] Call `generate_program_sessions` again on an already-generated program
      (same or overlapping range)
- [ ] Confirm `inserted_count = 0`, `skipped_count` = the full occurrence
      count in the requested window
- [ ] Confirm no duplicate `events` rows for any (rule, occurrence_date) pair

### 27B2-12: All-or-nothing conflict rejection

- [ ] Book a member reservation (or create an unrelated event) on a specific
      court/time
- [ ] Create a program whose rule would generate an occurrence on that exact
      court/time, among other non-conflicting occurrences in the same call
- [ ] Call `generate_program_sessions` → expect `court_conflict`
- [ ] Confirm **zero** events were created for this program — including the
      occurrences that would NOT have conflicted (true all-or-nothing, no
      partial batch)

### 27B2-13: Occurrence count ceiling

- [ ] Attempt to preview or generate a window that would produce more than
      200 occurrences (e.g. a program with several rules over the full
      26-week range) → `too_many_occurrences`

### 27B2-14: DST transition

- [ ] Create a program with one weekly rule spanning a known DST transition
      date in the club's timezone
- [ ] Generate sessions
- [ ] Confirm every generated occurrence's **club-local** wall-clock start
      time is identical (e.g. always 9:00 AM local) on both sides of the
      transition, and the UTC offset shifts by exactly one hour across it —
      i.e. no hour-of-day drift. Use `verify_phase27b2.sql` check D9's
      query shape (`(starts_at at time zone tz) - (starts_at at time zone
      'UTC')`) — **not** `extract(timezone_hour from starts_at)`, which
      reads the database session's own TimeZone setting rather than the
      club's IANA zone and is not a valid check here

### 27B2-15: Program status and archive/cancelled guards

- [ ] Attempt `generate_program_sessions` on a program whose `status` is
      already `cancelled` or `completed` → `program_not_generatable`
- [ ] Archive a program's row directly (`archived_at` set) and attempt
      `generate_program_sessions` → `program_archived`
- [ ] Confirm `generate_program_sessions` on an already-`active` program
      (one that was already generated once) succeeds normally for any new
      date range added later, without erroring on the status check

### 27B2-16: Pro ownership restrictions

- [ ] Pro A creates a program
- [ ] Pro B (same club) calls `preview_program_sessions` and
      `generate_program_sessions` against Pro A's program → both
      `insufficient_role`
- [ ] Admin calls both successfully against Pro A's program

### 27B2-17: Cross-club isolation

- [ ] Admin of Club A attempts `preview_program_sessions` /
      `generate_program_sessions` with a `program_id` belonging to Club B →
      `program_not_found` (not a permission-specific error — the program is
      simply invisible outside its club, matching every other club-scoped
      RPC's not-found-not-forbidden convention in this schema)

---

## No Regression to Existing Event Behavior

### 27B2-18: create_event / join_event / cancel_event unaffected

- [ ] Create a standalone (non-program) event via the existing Calendar/
      Admin flow — confirm success exactly as before, all four program
      columns NULL/false
- [ ] Join, leave, waitlist, cancel, archive a standalone event — confirm
      all existing behavior unchanged
- [ ] Confirm `verify_phase27b2.sql` check C3 (no existing event RPC
      references any Phase 27 column) still returns 0 rows

---

## Ownership Preservation (0089)

### 27B2-19: Admin generates a Pro-owned program

- [ ] As Pro A, call `create_program` → confirm `created_by` = Pro A's id
- [ ] As **Admin** (a different person), call `generate_program_sessions`
      on Pro A's program
- [ ] Confirm every generated event's `created_by` = **Pro A's** id, not the
      Admin's
- [ ] Confirm every generated reservation's `owner_user_id` and
      `created_by` = **Pro A's** id, not the Admin's
- [ ] Confirm the `audit_log` row for this call has `actor_id` = the
      **Admin's** id (the real invoker), and `metadata->>'program_owner_id'`
      = Pro A's id, `metadata->>'generated_by_id'` = the Admin's id
- [ ] As **Pro A**, call `cancel_event` or `archive_event` on one of the
      generated event ids → succeeds (Pro A's existing `created_by`-based
      ownership check passes, because ownership was preserved)
- [ ] As a **different Pro** (Pro B, not the program owner), attempt
      `cancel_event`/`archive_event` on the same generated event →
      `insufficient_role` (ownership correctly excludes non-owning Pros too)

---

## Overlapping-Rule Rejection (0089)

### 27B2-20: Same court, overlapping windows — rejected

- [ ] `create_program` with two rules: same `day_of_week`, sharing one
      court, windows `09:00-10:30` and `10:00-11:00` (overlap) →
      `overlapping_program_rules`
- [ ] Confirm no `programs`/`program_schedule_rules`/`program_rule_courts`
      row was created

### 27B2-21: Overlapping windows, different courts — allowed

- [ ] `create_program` with two rules: same `day_of_week`, **disjoint**
      `court_ids` (no shared court), overlapping windows (e.g. `09:00-10:00`
      on Court A and `09:30-10:30` on Court B) → succeeds
- [ ] Confirm both rules and both court assignments were created

### 27B2-22: Adjacent windows, same court — allowed

- [ ] `create_program` with two rules: same `day_of_week`, same court,
      windows `09:00-10:00` and `10:00-11:00` (touching, not overlapping —
      half-open range semantics) → succeeds

### 27B2-23: Batch self-conflict inside generate_program_sessions

- [ ] As service role (SQL Editor), directly `insert` two
      `program_schedule_rules` rows for the same program with the same
      `day_of_week` and overlapping times sharing a court — bypassing
      `create_program`'s own guard entirely, simulating a program defined
      before 0089 existed
- [ ] As the program's owner, call `generate_program_sessions` →
      `court_conflict`, with `detail` beginning `batch_self_conflict`
- [ ] Confirm **zero** events were created for this program (all-or-nothing
      preserved even for this batch-internal conflict case)

---

## Definition Revalidation (0089)

### 27B2-24: Event type deactivated after program creation

- [ ] `create_program` successfully (event_type is active at this point)
- [ ] As Admin, deactivate that event_type (`set_event_type_active(id, false)`)
- [ ] Call `preview_program_sessions` on the program → `event_type_not_found`
- [ ] Call `generate_program_sessions` on the program → `event_type_not_found`
- [ ] Reactivate the event_type; confirm both calls now succeed again

### 27B2-25: Court deactivated after program creation

- [ ] `create_program` successfully with a rule assigned to Court X
- [ ] As Admin, deactivate Court X (`is_active = false`)
- [ ] Call `preview_program_sessions` on the program → `court_not_found`
- [ ] Call `generate_program_sessions` on the program → `court_not_found`
- [ ] Reactivate Court X; confirm both calls now succeed again

### 27B2-26: Rule left with zero courts

- [ ] `create_program` successfully with one rule assigned to a single
      court
- [ ] As service role, delete that rule's only `program_rule_courts` row
      directly (simulating a state `create_program`'s own validation would
      never itself produce, but that must still be caught defensively)
- [ ] Call `preview_program_sessions` on the program → `rule_requires_court`
- [ ] Call `generate_program_sessions` on the program → `rule_requires_court`
- [ ] Confirm no event with `court_count = 0` exists anywhere:
      `select count(*) from events where program_id is not null and court_count = 0`
      → 0, always

---

## Malformed JSON Hardening (0089)

### 27B2-27: Stable error codes, not raw Postgres cast exceptions

For each `p_rules` payload below (all other `create_program` fields valid),
confirm the **named** error code is returned, not a generic Postgres
exception (e.g. `invalid input syntax for type integer`):

- [ ] `[{"day_of_week": "not a number", ...}]` → `invalid_day_of_week`
- [ ] `[{"day_of_week": 3.7, ...}]` → `invalid_day_of_week`
- [ ] `[{"start_time": "09:00", "duration_minutes": 60, "court_ids": [...]}]`
      (`day_of_week` key entirely absent) → `invalid_day_of_week`
- [ ] `[{"day_of_week": 2, "start_time": "not-a-time", ...}]` → `invalid_start_time`
- [ ] `[{"day_of_week": 2, "start_time": "25:99", ...}]` → `invalid_start_time`
- [ ] `[{..., "duration_minutes": "abc", ...}]` → `invalid_duration`
- [ ] `[{..., "duration_minutes": 45.5, ...}]` → `invalid_duration`
- [ ] `[{"day_of_week": 2, "start_time": "09:00", "court_ids": [...]}]`
      (`duration_minutes` key entirely absent) → `invalid_duration`
- [ ] `[{..., "capacity_override": "abc", ...}]` → `invalid_capacity_override`
- [ ] `[{..., "capacity_override": true, ...}]` → `invalid_capacity_override`
- [ ] `[{..., "court_ids": ["not-a-uuid"]}]` → `court_not_found`
- [ ] `["just a string", "not an object"]` (array element not an object) →
      `invalid_rules_payload`
- [ ] `[{..., "court_ids": "not-an-array"}]` → `rule_requires_court`
- [ ] Confirm **no** `programs` row was created for any of the above
