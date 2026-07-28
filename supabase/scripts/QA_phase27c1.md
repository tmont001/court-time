# Phase 27C.1 QA Checklist — Draft Program Editing and Conflict Recovery

Covers Phase 27C.1: migration `0090_draft_program_updates.sql` (adds
`update_program` only) plus the UI that exercises it (`CreateProgramSheet`'s
new edit mode, `ProgramPreviewSheet`'s Back to Programs / Edit Draft). Requires
`0087`, `0088`, and `0089` already applied.

**Scope reminder:** editing is only possible for a **draft** program with
**zero generated events**. The moment `generate_program_sessions` creates
even one event, the program transitions to `active` and `update_program`
permanently refuses it (`program_not_editable` / `program_already_generated`).
No enrollment, cancellation, active-series editing, payments, notifications,
or member-facing UI exists in this checkpoint.

Run `supabase/scripts/verify_phase27c1.sql` Sections A–C first — every check
there is signature/grant/body inspection and needs no live session. Section D
of that file is the condensed reference for the functional tests below.

---

## Pre-conditions

- [ ] Migrations `0087`–`0090` all applied
- [ ] `verify_phase27c1.sql` Sections A–C return the expected rows
- [ ] Staging/test project, not production
- [ ] A club with: 2+ active event types, 3+ active courts, one Admin, two
      Pros (Pro A, Pro B)

---

## update_program — direct RPC behavior

### 27C1-1: Admin updates a same-club draft

- [ ] As Admin, create a draft program (1 rule, 1 court)
- [ ] Call `update_program` with a different title, different dates, and a
      completely different rule set (2 rules, 2 different courts)
- [ ] Confirm the returned row reflects every new field
- [ ] Confirm `program_schedule_rules` for this program is **exactly** the
      new rule set — the original rule row is gone, not just superseded
      (proves DELETE+INSERT replacement, not an in-place patch)
- [ ] Confirm `program_rule_courts` reflects exactly the new court
      assignments
- [ ] Confirm an `audit_log` row exists: `action = 'update_program'`,
      metadata contains both `before` and `after` objects with the old and
      new title/enrollment_model/dates/capacity/event_type_id

### 27C1-2: Pro updates their own draft

- [ ] As Pro A, create a draft
- [ ] Call `update_program` on it → succeeds
- [ ] Confirm `created_by` is still Pro A's id

### 27C1-3: Pro cannot update another owner's draft

- [ ] Pro A creates a draft
- [ ] Pro B (same club) calls `update_program` on Pro A's `program_id` →
      `insufficient_role`
- [ ] Confirm the program's `title`/`updated_at`/rules are all unchanged

### 27C1-4: Cross-club isolation

- [ ] Admin of Club A calls `update_program` with a `program_id` belonging
      to Club B → `program_not_found` (not a permission error — the program
      is invisible outside its club, same convention as every other
      club-scoped RPC in this schema)

### 27C1-5: Generated/active program rejection

- [ ] Create a draft, call `generate_program_sessions` on it (now `active`,
      has events), then attempt `update_program` → `program_already_generated`
- [ ] Confirm zero rule/court changes resulted
- [ ] (If reachable) attempt `update_program` on any non-draft status
      (`cancelled`/`completed`) → `program_not_editable`
- [ ] Attempt `update_program` on an archived program (`archived_at` set) →
      `program_not_editable`

### 27C1-6: Atomic rule replacement + previous definition survives a
rejected update

- [ ] Note a draft's current rules/courts exactly
- [ ] Attempt `update_program` with a payload that fails validation **after**
      per-rule parsing succeeds but at the cross-rule check — e.g. two rules
      sharing a court with overlapping times → `overlapping_program_rules`
- [ ] Confirm the program's rules/courts are **byte-for-byte identical** to
      before the attempt — nothing was deleted or partially replaced
- [ ] Repeat with a malformed-field payload (see 27C1-9) — same expectation

### 27C1-7: Conflict removed after editing (the core 27C.1 scenario)

- [ ] Book a member reservation on a specific court/time
- [ ] Create a draft whose rule would generate an occurrence on that exact
      court/time
- [ ] Call `preview_program_sessions` → confirm that occurrence shows
      `has_conflict = true`
- [ ] Call `update_program` changing that rule's `start_time` (or `court_ids`)
      so it no longer collides
- [ ] Call `preview_program_sessions` again → confirm the conflict is gone
      (either the occurrence now shows `has_conflict = false`, or a
      different occurrence appears in its place if the day/time changed)
- [ ] Confirm Generate is no longer blocked

### 27C1-8: created_by unchanged across a cross-role edit

- [ ] Pro A creates a draft
- [ ] Admin calls `update_program` on it
- [ ] Confirm `created_by` is still Pro A's id, never the Admin's

### 27C1-9: Malformed input — stable error codes

For each `p_rules` payload below (all other fields valid), confirm the
**named** code, not a raw Postgres cast error:

- [ ] Missing `day_of_week` → `invalid_day_of_week`
- [ ] `day_of_week: 3.7` → `invalid_day_of_week`
- [ ] `start_time: "not-a-time"` → `invalid_start_time`
- [ ] `start_time: "25:99"` → `invalid_start_time`
- [ ] Missing `duration_minutes` → `invalid_duration`
- [ ] `capacity_override: "abc"` → `invalid_capacity_override`
- [ ] `court_ids: ["not-a-uuid"]` → `court_not_found`
- [ ] Array element not an object → `invalid_rules_payload`
- [ ] `court_ids` not an array → `rule_requires_court`
- [ ] Confirm the program's definition is unchanged after every attempt

### 27C1-10: Privileges and membership-native authorization

- [ ] As a Member (not Admin/Pro), attempt `update_program` on any program →
      `insufficient_role`
- [ ] Confirm `verify_phase27c1.sql` Section A/B all pass (SECURITY DEFINER,
      search_path pinned, authenticated-only EXECUTE, membership-native
      helper usage, no legacy `profiles` column reads)

---

## Edit UI

### 27C1-11: Edit Draft appears only where expected

- [ ] Open Preview on a **draft** program you (Admin, or the owning Pro)
      may manage → confirm **Edit Draft** appears in the header
- [ ] Open Preview on an **active** program → confirm **Edit Draft** does
      **not** appear
- [ ] As Pro B, open Preview on Pro A's **draft** program → confirm **Edit
      Draft** does **not** appear (Pro B cannot manage it)
- [ ] As Member — confirm the entire Manage → Programs subview is
      unreachable in the first place (unchanged from Phase 27C)

### 27C1-12: Edit form prefill

- [ ] Click **Edit Draft** → confirm the create/edit sheet opens with every
      field prefilled: title, description, event type, enrollment model,
      start/end dates, default capacity, and **every** schedule rule with
      its correct day, start time, duration, capacity override (if any),
      and court selection
- [ ] Confirm the sheet's step titles and submit button read "Edit Program
      Details" / "Confirm Changes" / "Save Changes" (not the create-mode
      copy)

### 27C1-13: Edit → save → reopen preview

- [ ] From the prefilled edit form, change one rule's time to remove a
      conflict, click through to Confirm, and Save Changes
- [ ] Confirm the sheet closes, the Programs list refreshes, and Preview
      reopens automatically for the same program showing the corrected
      definition
- [ ] Confirm Generate is no longer blocked by the previously-conflicting
      occurrence

### 27C1-14: Back to Programs button

- [ ] Open Preview on any program (mobile width) → confirm a clearly
      visible **"← Back to Programs"** text button is present in the
      header, distinct from (and in addition to) the existing close
      affordance, and clicking it returns to the Programs list
- [ ] Repeat at desktop width — confirm both the **×** close button (top
      right) and **"← Back to Programs"** are present and both work

### 27C1-15: Stale-club protection preserved

- [ ] Begin editing a draft, switch active club in another tab, then submit
      the edit → confirm the app-wide stale-club overlay blocks the page
      before any mutation fires (same protection as create/generate)

---

## No Regression

### 27C1-16: create_program and generation unaffected

- [ ] Re-run `QA_phase27b2.md`'s `create_program`/`preview_program_sessions`/
      `generate_program_sessions` checks (27B2-1 through 27B2-18) — every
      expected result is identical to before 0090
- [ ] Confirm `verify_phase27c1.sql` Section C returns the expected rows
      (no regression to existing RPC signatures, table grants, or RLS)
