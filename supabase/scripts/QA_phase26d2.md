# Phase 26D2 QA Checklist — Per-Club Membership Administration

Covers Phase 26D2: migration `0086_per_club_membership_administration.sql`
plus `src/app/(app)/admin/members/actions.ts` and `MembersClient.tsx`.
Requires migrations `0081`-`0085` already applied and verified. Run
`supabase/scripts/verify_phase26d2.sql` first.

**Scope reminder:** this checkpoint only changes membership status/removal/
restoration administration within the Admin's own active club. Invitation
acceptance, club switching, and role-change mechanics are unaffected — only
role's *interaction* with the corrected last-admin guard was touched, not
role-change behavior itself.

Use disposable test accounts and at least one test club with 2+ admins
available (so last-admin protection can be tested without permanently
locking yourself out of the test club).

---

## Pre-conditions

- [ ] Migrations `0081`-`0085` applied and previously verified
- [ ] Migration `0086` applied
- [ ] `verify_phase26d2.sql` returns no unexpected rows

---

## 1. Status vocabulary

- [ ] As Admin, deactivate an active disposable Member — confirm unchanged
      behavior (blocked from booking/joining), same as before this
      checkpoint
- [ ] Reactivate — confirm restored access
- [ ] **Suspend** an active disposable Member — confirm they lose access
      identically to deactivation, and the member list shows a distinct
      "Suspended" badge (not "Inactive")
- [ ] Reactivate from suspended — confirm restored access

## 2. Explicit removal

- [ ] Remove an active disposable Member — confirm a confirmation dialog
      appears first, clearly stating this affects their membership in this
      club only (not their account or other clubs)
- [ ] Confirm the member disappears from the main roster list immediately
      after removal
- [ ] **[SQL]** Confirm `club_memberships.removed_at`/`removed_by` are set,
      `role`/`status` are unchanged from before removal
- [ ] Confirm the removed member now appears in the new "Removed from this
      club" section at the bottom of `/admin/members`

## 3. Explicit restoration

- [ ] From the "Removed from this club" section, click "Restore" on the
      member from #2 — confirm no confirmation dialog (non-destructive)
- [ ] Confirm they reappear in the main roster list with their pre-removal
      role/status intact (not reset to some default)
- [ ] **[SQL]** Confirm `removed_at`/`removed_by` are both `null`

## 4. Removal while suspended, then restore

- [ ] Suspend a disposable Member, then Remove them while suspended
- [ ] Restore them — confirm they come back **still suspended**, not
      silently reactivated — matching the documented "restore never touches
      status" design
- [ ] Separately reactivate them via the normal status action

## 5. Last-admin protection

- [ ] With exactly one active Admin in the test club, attempt to
      Deactivate, Suspend, and Remove that Admin — confirm `last_admin` is
      rejected for all three, with controls visibly disabled in the UI
      (Deactivate/Suspend/Remove all disabled, matching the existing
      "Last admin — cannot change" messaging already shown for role)
- [ ] Add a second Admin, then confirm the original Admin's Deactivate/
      Suspend/Remove controls become enabled again

## 6. Last-admin guard does not over-block

- [ ] **[SQL]** Set a disposable Admin's status directly to `inactive`
      (simulating a pre-existing inactive admin) while the club has other
      active admins
- [ ] As Admin, attempt to Suspend that already-inactive admin — confirm it
      succeeds (does not incorrectly trigger `last_admin`, since they were
      never counted as an active admin to begin with)
- [ ] **[SQL]** Restore to a clean state when done

## 7. Self-restriction

- [ ] Attempt to change your own status, suspend yourself, or remove
      yourself — confirm each is rejected (`cannot_change_own_status` /
      `cannot_remove_self`), matching the existing self-role-change
      restriction

## 8. Cross-club isolation

- [ ] **[SQL]** Confirm a target user's `club_memberships` row in a
      *different* club is completely unaffected by any action taken in
      #1-#4 — same `role`/`status`/`removed_at` as before
- [ ] Confirm no UI anywhere on `/admin/members` or the member detail page
      shows or references any club other than the Admin's own active one

## 9. Active-club fallback for the target user

- [ ] Using the disposable two-club test account (or an equivalent) with
      Club B as its active club: as an Admin of Club B, deactivate/suspend/
      remove that account's Club B membership
- [ ] **[SQL]** Confirm the account's `active_club_id`: reassigns to Club A
      automatically only if Club A is their *sole* other active, non-removed
      membership; otherwise clears to `null` — never guessed among 2+
      alternatives
- [ ] Confirm `profiles.club_id/role/status/is_lesson_provider` (legacy
      projection) are updated correctly to match, via the unmodified 0081
      triggers

## 10. Directory correctness

- [ ] Confirm `get_members()`'s existing search/sort/filter behavior on the
      main roster is unchanged for active/inactive members
- [ ] Confirm removed members never appear in search results, sort, or the
      role/status filters — only in the dedicated "Removed from this club"
      section
- [ ] Confirm the "Removed from this club" count and member count elsewhere
      (e.g. total member count shown in the header, if any) do not double-
      count removed members

## 11. No cross-club membership list, no global deletion

- [ ] Confirm nothing in this checkpoint's UI shows a list of clubs or
      memberships belonging to any club other than the Admin's own active
      one
- [ ] Confirm no control anywhere deletes a user's account or profile —
      every action here only ever touches one `club_memberships` row
