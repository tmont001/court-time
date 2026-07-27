# Phase 26B2 QA Checklist — Active-Club Authorization Foundation

Covers Phase 26B2: migration `0082_active_club_authorization_foundation.sql`.
Requires `0081_club_membership_compatibility_foundation.sql` already applied
and verified (`verify_phase26b1.sql` green).

**Scope reminder:** 0082 redefines `current_user_club_id()`/
`current_user_role()`, adds `current_user_is_lesson_provider()` and
`set_active_club()`, and makes **two narrow RLS corrections** on
`public.profiles` — `profiles_select_same_club` and
`profiles_update_own_row` — made necessary by the two helpers above now
correctly failing closed for any user without a valid active membership. No
other RLS policy changes, no existing RPC body changes, no application code
changes. There is no switcher UI — none should appear anywhere in this
checklist. Run `supabase/scripts/verify_phase26b2.sql` first; every Section
A/B/C/D/E check there should pass before starting the manual steps here.

---

## Pre-conditions

- [x] Migration `0081` applied and its QA/verification previously passed
- [x] Migration `0082` applied
- [x] `verify_phase26b2.sql` Sections A, B, C, D, E return no unexpected rows
- [ ] Staging/test project, not production, for every step below that
      mutates data (Section 2 and 3 only — Section 4 is read-only
      observation of the running app)

---

## 1. Claim-simulation method, and why setup and authenticated execution are separated

A plain Supabase SQL Editor session has no application JWT, so `auth.uid()`
resolves to `NULL` by default. This project's `auth.uid()` resolves from the
PostgREST request-scoped GUCs `request.jwt.claim.sub` / `request.jwt.claims`,
settable manually and scoped to one transaction via `set_config(..., true)`
(the `true` third argument is `is_local`, equivalent to `SET LOCAL` — never
the session-wide form).

**Setup and authenticated execution must be separated**, because migration
0081 deliberately revoked all direct `authenticated`/`anon` privileges on
`public.club_memberships` and created zero policies for it (by design — no
browser code needs direct access). If the test switches to `SET LOCAL ROLE
authenticated` and then tries to `INSERT` a second test membership directly,
that `INSERT` will correctly fail with a permission error — not because the
test is broken, but because that is exactly the boundary this schema
enforces. All privileged setup (creating test rows, asserting starting
state) must happen **before** switching role; all calls meant to prove
`authenticated`-level behavior must happen **after** switching role; and
`RESET ROLE` is used to return to the privileged role for read-only
inspection between authenticated calls.

**Mandatory verification gate:** after setting claims and switching role,
`select auth.uid();` must return the exact disposable user id before any
further step proceeds. If it does not match, **stop** — do not proceed as if
authenticated; use the fallback below instead.

**Fallback method (if the claim simulation does not work in this
environment):** sign in as the disposable account through the actual running
application (or via `supabase.auth.signInWithPassword` from a short script
using the project's anon key), capture the resulting access token, and call
the four public functions through PostgREST's `/rest/v1/rpc/<function_name>`
endpoint with that token in the `Authorization: Bearer <token>` header —
genuinely authenticated, not simulated.

---

## 2. Transactional Authenticated QA — set_active_club (disposable user, rolled back)

**Preparation (once, outside any transaction, as a normal test-data step):**

- [ ] Confirm a disposable test account exists with an active membership in
      a first test club (reuse Phase 26B1's disposable account if present)
- [ ] Record its profile id, and the `club_id` of its current (first) club
- [ ] Identify or create a **second** test club it does not yet belong to,
      and record its `club_id`

The whole test below is **one transaction**, following the task's required
structure: privileged setup first, then claims, then role switch, then
authenticated-only calls, toggling `RESET ROLE` / `SET LOCAL ROLE
authenticated` as needed, ending in `ROLLBACK`.

```sql
begin;

-- ── STEP 1: privileged setup (still the SQL Editor's own role) ─────────────
-- Assert starting state and prepare test rows while we still have direct
-- table access. None of this would be possible once we switch to
-- `authenticated` below — that is the point.

do $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles where id = '<disposable profile id>';
  if not found then
    raise exception 'guard_failed: disposable profile not found';
  end if;
  if v_profile.active_club_id is distinct from '<first club id>'::uuid then
    raise exception 'guard_failed: disposable profile is not active in the expected first club';
  end if;
end;
$$;

-- Insert (or restore) the second membership directly, as the privileged
-- role — authenticated could not do this (see the demonstration in STEP 3).
insert into public.club_memberships (user_id, club_id, role, status, is_lesson_provider)
values ('<disposable profile id>', '<second club id>', 'member', 'active', false)
on conflict (user_id, club_id) do update
  set status = 'active', removed_at = null, removed_by = null;

-- Record original state for the final rollback-comparison.
select active_club_id, club_id, role, status, updated_at
  from public.profiles where id = '<disposable profile id>';
-- (record this row's values before continuing)

-- ── STEP 2: set transaction-local JWT claims ────────────────────────────────
select set_config('request.jwt.claim.sub', '<disposable profile id>', true);
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '<disposable profile id>', 'role', 'authenticated')::text,
  true
);

-- ── STEP 3: switch to authenticated ─────────────────────────────────────────
set local role authenticated;

-- MANDATORY GATE — must equal the disposable profile id before proceeding.
select auth.uid();

-- Demonstrate the isolation boundary: authenticated cannot read or write
-- club_memberships directly, even though set_active_club (SECURITY DEFINER)
-- will succeed against the same table two steps below. Each attempt is
-- wrapped in its own exception harness so an expected permission error does
-- not poison this outer transaction (see Section 3 for the harness pattern
-- used more extensively against set_active_club itself).
do $$
begin
  begin
    perform 1 from public.club_memberships limit 1;
    raise exception 'expected_permission_denied_not_raised (SELECT)';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

do $$
begin
  begin
    insert into public.club_memberships (user_id, club_id, role, status)
    values ('<disposable profile id>', '<second club id>', 'member', 'active');
    raise exception 'expected_permission_denied_not_raised (INSERT)';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ── STEP 4: existing active club, via the public authenticated functions ───
select public.current_user_club_id();           -- expect: first club's id
select public.current_user_role();               -- expect: role in that club
select public.current_user_is_lesson_provider();  -- expect: that membership's flag

-- ── STEP 5: switch, still authenticated (set_active_club is SECURITY
-- DEFINER, so it succeeds here despite STEP 3's direct-access denial) ──────
select * from public.set_active_club('<second club id>');
select public.current_user_club_id();           -- expect: second club's id now
select public.current_user_role();
select public.current_user_is_lesson_provider();

-- ── STEP 6: RESET ROLE to inspect directly ──────────────────────────────────
reset role;

select active_club_id, club_id, role, status, is_lesson_provider
  from public.profiles where id = '<disposable profile id>';
-- expect: active_club_id = second club id; club_id/role/status/
-- is_lesson_provider match the second membership (Trigger C's projection)

-- ── STEP 7: re-enter authenticated for the next RPC call ───────────────────
set local role authenticated;
select public.set_active_club('<first club id>');   -- switch back

reset role;
select active_club_id, club_id, role, status from public.profiles
  where id = '<disposable profile id>';
-- expect: back to the first club's values

-- ── STEP 8: idempotent call ─────────────────────────────────────────────────
select updated_at from public.profiles where id = '<disposable profile id>';
-- record this value

set local role authenticated;
select public.set_active_club('<first club id>');   -- already active; no-op

reset role;
select updated_at from public.profiles where id = '<disposable profile id>';
-- expect: byte-identical to the value recorded just above (no UPDATE fired)

rollback;
```

- [ ] `auth.uid()` matched the disposable profile id after the role switch
- [ ] Both direct `club_memberships` attempts (SELECT, INSERT) raised
      `insufficient_privilege`, caught by their own harness, without
      aborting the transaction
- [ ] STEP 4's three helper calls returned the first club's values
- [ ] STEP 5's `set_active_club` succeeded (despite `authenticated` having no
      direct table access) and the three helpers immediately reflected the
      second club
- [ ] STEP 6 (privileged) confirms the profile projection matches the second
      membership
- [ ] STEP 7 confirms switching back restores the first club everywhere
- [ ] STEP 8 confirms `updated_at` is unchanged across the idempotent call
- [ ] After `rollback`, re-run (in a fresh, ordinary read-only query) a
      check that the second club's `club_memberships` row no longer exists
      for this user and `profiles` is back to its pre-test state

---

## 3. Expected-Error Testing — set_active_club invalid targets

Each invalid case runs inside its own `DO $$ ... EXCEPTION ... END $$;`
harness, per the task's required pattern, so the outer transaction remains
usable after each expected failure — five unhandled exceptions in a row
would otherwise abort the whole transaction after the first one.

All privileged setup (creating the inactive/suspended/removed test rows)
happens **before** switching role, exactly as in Section 2. The exception
harness itself runs only after `set local role authenticated`, and performs
no direct protected-table setup — only the `set_active_club` call.

```sql
begin;

-- Privileged setup: prepare one club_memberships row in each invalid state
-- for the disposable user, plus identify a club with no membership row at
-- all (any real club id the disposable user has never joined).
update public.club_memberships
   set status = 'inactive'
 where user_id = '<disposable profile id>' and club_id = '<inactive test club id>';

update public.club_memberships
   set status = 'suspended'
 where user_id = '<disposable profile id>' and club_id = '<suspended test club id>';

update public.club_memberships
   set removed_at = now(), removed_by = '<disposable profile id>'
 where user_id = '<disposable profile id>' and club_id = '<removed test club id>';

select set_config('request.jwt.claim.sub', '<disposable profile id>', true);
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '<disposable profile id>', 'role', 'authenticated')::text,
  true
);

set local role authenticated;
select auth.uid();  -- MANDATORY GATE — must match before continuing

-- Case 1: NULL club id.
do $$
begin
  begin
    perform public.set_active_club(null);
    raise exception 'expected_invalid_active_club_not_raised (null)';
  exception
    when others then
      if sqlerrm <> 'invalid_active_club' then raise; end if;
  end;
end;
$$;

-- Case 2: club with no membership row at all.
do $$
begin
  begin
    perform public.set_active_club('<club id with no membership row>');
    raise exception 'expected_invalid_active_club_not_raised (no membership)';
  exception
    when others then
      if sqlerrm <> 'invalid_active_club' then raise; end if;
  end;
end;
$$;

-- Case 3: inactive membership.
do $$
begin
  begin
    perform public.set_active_club('<inactive test club id>');
    raise exception 'expected_invalid_active_club_not_raised (inactive)';
  exception
    when others then
      if sqlerrm <> 'invalid_active_club' then raise; end if;
  end;
end;
$$;

-- Case 4: suspended membership.
do $$
begin
  begin
    perform public.set_active_club('<suspended test club id>');
    raise exception 'expected_invalid_active_club_not_raised (suspended)';
  exception
    when others then
      if sqlerrm <> 'invalid_active_club' then raise; end if;
  end;
end;
$$;

-- Case 5: removed membership.
do $$
begin
  begin
    perform public.set_active_club('<removed test club id>');
    raise exception 'expected_invalid_active_club_not_raised (removed)';
  exception
    when others then
      if sqlerrm <> 'invalid_active_club' then raise; end if;
  end;
end;
$$;

reset role;
select active_club_id from public.profiles where id = '<disposable profile id>';
-- expect: unchanged by any of the five cases above

rollback;
```

- [ ] All five `DO` blocks completed without re-raising — i.e. every case
      produced exactly `invalid_active_club`, no other error text, and no
      case revealed which specific condition (missing/inactive/suspended/
      removed) applied
- [ ] `active_club_id` after all five attempts is unchanged from before them
- [ ] Transaction rolled back; no production/real-user state touched

---

## 4. Focused Own-Profile RLS QA (authenticated, rolled back)

Exercises `profiles_select_same_club` and `profiles_update_own_row` directly,
across three states of the same disposable user, reusing the setup/claims/
role-switch pattern from Sections 2-3. All privileged state transitions
happen before each `set local role authenticated` block; `RESET ROLE`
between blocks for direct inspection.

### 4a. Active user (in a club, with at least one other member to compare against)

Privileged: confirm the disposable user is active in the first test club,
and identify one other real profile id that is also an active member of
that same club (`<same-club-other-member id>`), plus, if available, one
profile id in a different club (`<other-club-member id>`).

```sql
begin;
select set_config('request.jwt.claim.sub', '<disposable profile id>', true);
select set_config('request.jwt.claims',
  json_build_object('sub','<disposable profile id>','role','authenticated')::text, true);
set local role authenticated;
select auth.uid(); -- must match

select id from public.profiles where id = '<disposable profile id>';         -- own row
select id from public.profiles where id = '<same-club-other-member id>';     -- same club
select id from public.profiles where id = '<other-club-member id>';          -- different club
reset role;
rollback;
```

- [ ] Own row: 1 row returned
- [ ] Same-club other member: 1 row returned
- [ ] Different-club member (if one exists in this test project): 0 rows
      returned

### 4b. No-club disposable user

Privileged: temporarily set the disposable user's `active_club_id` and
`club_id` to `NULL` (simulating a no-club state) inside the transaction.

```sql
begin;
update public.profiles set active_club_id = null, club_id = null
 where id = '<disposable profile id>';

select set_config('request.jwt.claim.sub', '<disposable profile id>', true);
select set_config('request.jwt.claims',
  json_build_object('sub','<disposable profile id>','role','authenticated')::text, true);
set local role authenticated;
select auth.uid(); -- must match

select id from public.profiles where id = '<disposable profile id>';       -- own row
select id from public.profiles where id = '<same-club-other-member id>';   -- must be denied

update public.profiles set first_name = 'QA Test' where id = '<disposable profile id>';

do $$
begin
  begin
    update public.profiles set club_id = '<first club id>' where id = '<disposable profile id>';
    raise exception 'expected_permission_denied_not_raised (club_id)';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

do $$
begin
  begin
    update public.profiles set role = 'admin' where id = '<disposable profile id>';
    raise exception 'expected_permission_denied_not_raised (role)';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

reset role;
rollback;
```

- [ ] Own row still selectable (1 row)
- [ ] Same-club other member no longer selectable (0 rows — no active club)
- [ ] `first_name` update succeeded
- [ ] `club_id` and `role` update attempts both raised `insufficient_privilege`
      (column-level grant boundary from 0079, unaffected by 0082)

### 4c. Inactive disposable membership

Privileged: set the disposable user's `club_memberships` row for the first
club to `status = 'inactive'` (this cascades through Trigger B to clear
`active_club_id`, per Phase 26B1).

```sql
begin;
update public.club_memberships set status = 'inactive'
 where user_id = '<disposable profile id>' and club_id = '<first club id>';

select set_config('request.jwt.claim.sub', '<disposable profile id>', true);
select set_config('request.jwt.claims',
  json_build_object('sub','<disposable profile id>','role','authenticated')::text, true);
set local role authenticated;
select auth.uid(); -- must match

select id, status from public.profiles where id = '<disposable profile id>';  -- own row, status visible
select id from public.profiles where id = '<same-club-other-member id>';      -- must be denied
select public.current_user_club_id();   -- expect NULL
select public.current_user_role();       -- expect NULL

update public.profiles set last_name = 'QA Test' where id = '<disposable profile id>';

reset role;
rollback;
```

- [ ] Own row selectable, `status` visibly `'inactive'`
- [ ] Same-club other member not selectable
- [ ] `current_user_club_id()`/`current_user_role()` both `NULL`
- [ ] `last_name` self-edit still succeeds (own-row RLS boundary, unaffected
      by active-club state — this is exactly the regression sections 2-3 of
      the migration correct)

---

## 5. Manual Application Regression QA

No code changed in this checkpoint, so every one of these should be
**identical to pre-0082 behavior**. No switcher UI exists yet and none
should appear anywhere below.

### 26B2-1: Member sign-in

- [ ] Sign in as an existing Member — same landing page, same nav, as before

### 26B2-2: Pro sign-in

- [ ] Sign in as an existing Pro — same nav (including Lessons), as before

### 26B2-3: Admin sign-in

- [ ] Sign in as an existing Admin — same `/admin/*` access, as before

### 26B2-4: Calendar

- [ ] Loads courts/reservations/operating hours exactly as before

### 26B2-5: Events

- [ ] List/detail/join/leave behave exactly as before

### 26B2-6: Bookings

- [ ] `/my-schedule` shows the same reservations/signups as before

### 26B2-7: Lessons

- [ ] Lesson request/proposal flows and provider selector unchanged

### 26B2-8: Members (admin)

- [ ] Admin member directory lists the same members/roles/statuses

### 26B2-9: Courts

- [ ] Court list/management (admin) unchanged

### 26B2-10: Settings

- [ ] Club settings page loads/saves exactly as before

### 26B2-11: Invitation acceptance for a new no-club account

- [ ] Fresh sign-up, accept a valid invite — same redirect/behavior as
      Phase 26B1's equivalent check; confirm one `club_memberships` row and
      `active_club_id` set as before (0082 does not change this flow)

### 26B2-12: Deactivate/reactivate disposable user

- [ ] Repeat Phase 26B1's disposable-user deactivate/reactivate check —
      same app-visible behavior (blocked while inactive, restored on
      reactivation)
- [ ] Additionally confirm, via the transactional test in Section 3, that
      `current_user_club_id()`/`current_user_role()` for that user resolve
      to `NULL` while inactive (new, correct behavior — was not true of the
      pre-0082 helpers, which never checked status at all)
- [ ] Confirm the user's own profile page still loads and personal fields
      remain editable while inactive (Section 4c)

### 26B2-13: Role change

- [ ] As Admin, change a Member's role via the existing admin UI — same
      app-visible behavior; confirm via SQL that `club_memberships.role`
      updated (Phase 26B1 mechanism, unaffected by 0082)

### 26B2-14: Lesson Pro change

- [ ] As Admin, toggle Lesson Pro designation via the existing admin UI —
      same app-visible behavior; confirm via SQL that
      `club_memberships.is_lesson_provider` updated

### 26B2-15: No switcher UI

- [ ] Confirm no page, menu, or sheet anywhere in the app shows a club
      switcher, membership list, or any other multi-club UI element — none
      was built, none should appear

---

## 6. Known, audited behavior — now corrected vs. still open

- [ ] **Own-profile self-select/self-edit while inactive/suspended/removed/
      no-club**: previously flagged as a regression in the uncorrected
      0082 (an inactive user would lose the ability to see or edit even
      their own profile row). **This checkpoint corrects it** —
      `profiles_select_same_club` and `profiles_update_own_row` were
      narrowly replaced (see the migration's section 4 and this doc's
      Section 4). Confirm via Section 4b/4c above, not by testing against a
      real inactive user in production.
- [ ] **`lesson_requests_select_admin`**: confirm (via
      `verify_phase26b2.sql` Section C3) this policy's admin-role check
      still bypasses `current_user_role()` via its own inline
      `profiles.role` subquery, exactly as before 0082 — unaffected either
      way, still flagged for Phase 26C, not corrected in this checkpoint
      (it is not a "does not fail closed" regression introduced by 0082 —
      it predates it and behaves identically before and after).

---

## 7. Rollback

See the "Rollback procedure" comment block at the end of
`0082_active_club_authorization_foundation.sql` for the exact in-place
rollback: restore the two pre-0082 function bodies, restore the two
profiles RLS policies to their pre-0082 text (in that order — after the
function bodies, since the restored policy text calls them), then drop the
three new functions. It does not roll back 0081 — `club_memberships`,
`profiles.active_club_id`, and the four 0081 compatibility triggers remain
in place and correct regardless of whether 0082 is applied.
