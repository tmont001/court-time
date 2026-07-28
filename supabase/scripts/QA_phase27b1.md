# Phase 27B1 QA Checklist — Programs Schema Foundation

Covers Phase 27B1: migration `0087_programs_schema_foundation.sql`.

**Scope reminder:** 0087 is schema-only — no generation RPC, no enrollment
RPC, no UI. There is no product action yet that creates a program, a rule,
a court assignment, or an enrollment. This checklist is therefore about the
schema itself: constraints hold, RLS is correctly scoped, no direct write
path exists, and — critically — every existing standalone-event flow is
provably unaffected.

Run `supabase/scripts/verify_phase27b1.sql` first — every check in Sections
A–E should pass before starting the manual steps here.

---

## Pre-conditions

- [ ] Migration `0087_programs_schema_foundation.sql` applied
- [ ] `verify_phase27b1.sql` Sections A–E return the expected rows (0 for
      every "Expected: 0 rows" check)
- [ ] Staging/test project, not production, for the seeded-data steps below

---

## Existing Event Behavior — No Change

These confirm the four new nullable columns and new constraints on `events`
did not alter any existing flow.

### 27B1-1: Create a standalone event

- [ ] As Admin or Pro, create an ordinary event via the existing Calendar or
      Admin Events flow
- [ ] Confirm creation succeeds exactly as before
- [ ] Run:
  ```sql
  select id, program_id, program_schedule_rule_id, program_occurrence_date, is_program_exception
  from public.events
  where id = '<new event id>';
  ```
- [ ] Confirm `program_id`, `program_schedule_rule_id`, `program_occurrence_date`
      are all `NULL` and `is_program_exception = false`

### 27B1-2: Join / leave / waitlist / offer, unchanged

- [ ] Join the event as a Member; confirm success as before
- [ ] Fill the event to capacity with additional members; confirm waitlist
      behavior unchanged
- [ ] Have the confirmed member leave; confirm the waitlisted member is
      offered the spot exactly as before (`waitlist_offer` notification,
      accept/decline flow in `/my-schedule`)

### 27B1-3: Cancel / archive, unchanged

- [ ] Cancel the event as Admin; confirm existing `cancel_event` behavior
      (participant notifications, reservation cancellation) is unchanged
- [ ] Archive a past event; confirm existing `archive_event` behavior is
      unchanged

### 27B1-4: Guests, unchanged

- [ ] Add a guest to an event via the Admin roster; confirm
      `event_guests` behavior is unchanged

---

## No Direct Write Access to New Tables

There is no RPC yet, so the only way to attempt a write is a raw
PostgREST/Supabase-client call. Migration 0087 blocks that write at **two
independent layers**, and both should be confirmed:

1. **Table privileges** (section 7 of 0087) — `authenticated` was granted
   only `SELECT` on each of the four new tables; no `INSERT`/`UPDATE`/
   `DELETE`/`TRUNCATE`/`REFERENCES`/`TRIGGER` privilege was ever granted to
   it, and `anon`/`PUBLIC` were granted nothing at all. A write attempt at
   this layer fails with a Postgres permission error
   (`42501: permission denied for table ...`) before RLS is even evaluated.
2. **RLS default-deny** (section 6 of 0087) — even if a role somehow held
   the table privilege, no `INSERT`/`UPDATE`/`DELETE` policy exists on any
   of the four tables, so RLS denies the row-level check unconditionally.

`verify_phase27b1.sql` Section D proves layer 1 (D1/D2 for `authenticated`,
D3 for `anon`, D4 for `PUBLIC`); Section C proves layer 2 (C3: zero non-
SELECT policies). The steps below are the live, end-to-end confirmation that
a real write attempt is actually rejected — they don't distinguish which
layer fired (Postgres reports the privilege-layer error first), but between
them and the verify script, both layers are independently confirmed.

### 27B1-5: Authenticated member cannot insert a program

- [ ] Using the browser console or a REST client authenticated as any
      Member, attempt:
  ```
  POST /rest/v1/programs
  { "club_id": "<real club id>", "event_type_id": "<real event_type id>",
    "title": "test", "enrollment_model": "per_session",
    "starts_on": "2026-08-01", "ends_on": "2026-08-31",
    "default_capacity": 8, "created_by": "<own profile id>" }
  ```
- [ ] Confirm the request is rejected — expect a `42501 permission denied
      for table programs` error (the table-privilege layer rejects this
      before RLS is reached, since `authenticated` was never granted
      INSERT); this must fail regardless of role, including Admin

### 27B1-6: Authenticated admin cannot insert a program_enrollment

- [ ] Same as above, `POST /rest/v1/program_enrollments` as an Admin
- [ ] Confirm rejection with the same `42501 permission denied` error

### 27B1-7: anon has no access at all

- [ ] Using an unauthenticated (anon key) client, attempt
      `GET /rest/v1/programs`
- [ ] Confirm rejection with `42501 permission denied for table programs`
      (anon has no table privilege at all — see verify script Section D3)

---

## Cross-Club Isolation (seeded test data, staging only)

Seed minimal rows directly via the SQL Editor (service role / superuser
context bypasses RLS) to exercise the SELECT policies as two different real
club members. **Never do this against production data.**

### Setup

- [ ] Identify two distinct clubs already in staging, Club A and Club B,
      each with at least one Admin and one Member profile, and at least one
      court each
- [ ] As service role in the SQL Editor, seed one program per club:
  ```sql
  insert into public.programs (club_id, event_type_id, title, enrollment_model, starts_on, ends_on, default_capacity, created_by)
  select id, (select id from public.event_types where club_id = clubs.id limit 1),
         'QA Program - ' || clubs.name, 'per_session', current_date, current_date + 30, 6,
         (select id from public.profiles p join public.club_memberships cm on cm.user_id = p.id where cm.club_id = clubs.id and cm.role = 'admin' limit 1)
  from public.clubs clubs
  where clubs.id in ('<club A id>', '<club B id>');
  ```
- [ ] Confirm exactly 2 rows were inserted (one per club)

### 27B1-8: A club's programs are invisible from the other club

- [ ] Sign in as a Club A member (any role)
- [ ] Query `programs` via the app's normal Supabase client (or REST):
      confirm only Club A's seeded program is visible, never Club B's
- [ ] Repeat signed in as a Club B member: confirm only Club B's program is
      visible

### 27B1-9: program_enrollments visibility — member sees only their own row

- [ ] As service role, seed one `program_enrollments` row for a Club A
      Member (`status = 'enrolled'`) against the Club A program from Setup
- [ ] Seed a second `program_enrollments` row for a *different* Club A
      Member against the same program
- [ ] Sign in as the first Member: confirm only their own enrollment row is
      visible, not the second member's
- [ ] Sign in as the Club A Admin: confirm both enrollment rows are visible
- [ ] Sign in as a Club A Pro who did **not** create the program: confirm
      neither enrollment row is visible
- [ ] As service role, set that Pro as `created_by` on the Club A program;
      sign in as the same Pro again: confirm both enrollment rows are now
      visible

### 27B1-10: program_schedule_rules / program_rule_courts follow the same
club boundary

- [ ] As service role, seed one `program_schedule_rules` row (any valid
      day/time) and one `program_rule_courts` row (any court belonging to
      Club A) under the Club A program
- [ ] Sign in as a Club B member: confirm neither row is visible
- [ ] Sign in as a Club A member: confirm both rows are visible

### Cleanup

- [ ] Delete all rows seeded in this section (service role):
  ```sql
  delete from public.program_rule_courts where program_schedule_rule_id in
    (select id from public.program_schedule_rules where program_id in
      (select id from public.programs where title like 'QA Program - %'));
  delete from public.program_schedule_rules where program_id in
    (select id from public.programs where title like 'QA Program - %');
  delete from public.program_enrollments where program_id in
    (select id from public.programs where title like 'QA Program - %');
  delete from public.programs where title like 'QA Program - %';
  ```
- [ ] Confirm `verify_phase27b1.sql` check B5 (programs count) returns to 0
