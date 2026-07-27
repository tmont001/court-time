# Phase 26D1 QA Checklist — Additional-Club Invitation Acceptance

Covers Phase 26D1: migration `0084_additional_club_invitation_acceptance.sql`
plus `src/app/(auth)/join/[code]/page.tsx` and `actions.ts`. Requires
migrations `0081`-`0083` already applied and verified. Run
`supabase/scripts/verify_phase26d1.sql` first.

**Scope reminder:** this checkpoint only changes invitation acceptance. No
club switcher exists — none should appear anywhere below. Membership
removal/reactivation administration is Phase 26D2's job, not this one; the
inactive/suspended/removed destination-membership case is a hard rejection
here, not a reactivation flow.

Use disposable test accounts and at least two test clubs (Club A, Club B)
throughout — never a real member or production club.

---

## Pre-conditions

- [ ] Migrations `0081`-`0083` applied and previously verified
- [ ] Migration `0084` applied
- [ ] `verify_phase26d1.sql` returns no unexpected rows
- [ ] Staging/test project, not production

---

## 1. No-club user accepts first invitation (unchanged flow)

- [ ] Fresh sign-up, no prior membership
- [ ] Open a valid Club A invite link, accept it
- [ ] Confirm redirect to `/welcome` or `/calendar` exactly as before
- [ ] Confirm exactly one `club_memberships` row (Club A, role from invite,
      `status = 'active'`), `active_club_id = Club A`
- [ ] Confirm the invite's `accepted_at`/`accepted_by` are set

## 2. Active Club A member accepts a Club B invitation

- [ ] Using the disposable account from §1 (now an active Club A member),
      open a valid Club B invite link while signed in
- [ ] Confirm the page shows Club B's details plus the "you're currently
      active in Club A… will make Club B active" note — no "Already
      connected" dead end
- [ ] Accept the invitation
- [ ] **Club A membership remains**: confirm via SQL that the Club A
      `club_memberships` row is unchanged (same `role`/`status`, not removed)
- [ ] **Club B becomes active**: confirm `profiles.active_club_id` = Club B,
      and a new `club_memberships` row exists for Club B with the invite's
      role, `status = 'active'`, `removed_at is null`
- [ ] **Role/navigation changes to Club B's role**: sign back in (or refresh)
      and confirm SideNav/BottomNav and `/admin/*` access reflect Club B's
      role, not Club A's
- [ ] Confirm `profiles.club_id/role/status/is_lesson_provider` (legacy
      projection) match the new Club B membership (Trigger C, 0081)
- [ ] Confirm no switcher UI appeared at any point in this flow

## 3. Invitation consumed once / retry does not duplicate

- [ ] Attempt to open and accept the same Club B invite link a second time
      (same account) — confirm `invite_used`
- [ ] Attempt to double-submit Accept (rapid double-click, or two tabs) on a
      still-valid invite — confirm only one `club_memberships` row is
      created for (user, Club B), no duplicate-key error surfaces to the UI

## 4. Same-club active membership rejection

- [ ] While the disposable account's active club is Club B (from §2), open
      a *different*, still-valid invite link that also targets Club B
- [ ] Accept — confirm `already_member`, no duplicate row, `active_club_id`
      unchanged

## 5. Inactive/suspended/removed destination membership rejection

- [ ] **[SQL]** Set the disposable account's Club B membership to
      `status = 'inactive'`
- [ ] Open a fresh, valid invite to Club B and accept — confirm
      `membership_state_conflict`, and the membership is **not** silently
      reactivated (still `status = 'inactive'`)
- [ ] **[SQL]** Repeat for `status = 'suspended'`, and again for
      `removed_at` set — confirm `membership_state_conflict` in both cases,
      no restoration
- [ ] **[SQL]** Restore the Club B membership to `status = 'active'`,
      `removed_at = null` when done

## 6. Email mismatch

- [ ] As a signed-in disposable account, open an invite restricted to a
      *different* email address
- [ ] Accept — confirm `email_mismatch` and the sign-out prompt (unchanged
      from pre-26D1 behavior)

## 7. Expired / revoked / used invite

- [ ] Confirm expired, revoked, and already-used invite links show their
      existing error screens (`ERROR_CONTENT`/`ERROR_MESSAGES`), unchanged,
      for both a no-club and an already-clubbed signed-in user

## 8. No cross-club disclosure

- [ ] While active in Club B, confirm no page or error message reveals any
      detail about Club A (or any other club) beyond what the user already
      knows from being a member there
- [ ] Confirm `audit_log` entries from this checkpoint's acceptances are
      scoped to the destination club only (`club_id` = the club being
      joined), never appearing under an unrelated club's audit log

## 9. Regression smoke test

- [ ] Calendar, Events, Bookings load correctly for the disposable account
      in its (post-switch) active club
- [ ] Admin navigation correct if the disposable account is now an Admin/Pro
      in the newly active club
- [ ] No club switcher, membership list, or other multi-club UI element
      appears anywhere in the app
