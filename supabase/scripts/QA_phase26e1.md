# Phase 26E1 QA Checklist — Membership List and Club Switcher

Covers Phase 26E1: migration `0085_my_club_memberships.sql` plus the
switcher application changes (`SideNav.tsx`, `BottomNav.tsx`,
`ClubMembershipList.tsx`, `switchClubAction.ts`, `profile/page.tsx`,
`(app)/layout.tsx`). Requires migrations `0081`-`0084` already applied and
verified. Run `supabase/scripts/verify_phase26e1.sql` first.

**Scope reminder:** no membership-administration control (leave/remove/
reactivate) exists anywhere in this checkpoint's UI. Stale-tab conflict
detection is explicitly deferred to Phase 26E2 — do not expect or test for
any warning when switching in one tab/device while another is open.

Use the existing disposable two-club test account: **Generic Club** (Member)
and **Lakeview Test Club** (Pro), with Lakeview currently active.

---

## Pre-conditions

- [ ] Migrations `0081`-`0084` applied and previously verified
- [ ] Migration `0085` applied
- [ ] `verify_phase26e1.sql` returns no unexpected rows
- [ ] The disposable two-club account exists in the expected state (Generic:
      Member, Lakeview: Pro, both active/non-removed, Lakeview currently
      active)

---

## 1. One-club accounts — switcher does not appear

- [ ] Sign in as an existing one-club Member — SideNav/BottomNav show the
      plain static club-name text, no chevron, no "Switch club" control
- [ ] Same check for a one-club Pro
- [ ] Same check for a one-club Admin
- [ ] `/profile` shows no "Clubs" section for any of the three (only ever
      appears for 2+ active memberships)

## 2. Two-club account — switcher appears

- [ ] Sign in as the disposable two-club account
- [ ] Desktop: SideNav club-name area is now a button with a chevron
- [ ] Mobile: BottomNav's More sheet shows a "Switch club" control next to
      the club name
- [ ] `/profile` shows a "Clubs" section listing both Generic Club (Member)
      and Lakeview Test Club (Pro)

## 3. Desktop switcher — Lakeview Pro → Generic Member

- [ ] Click the SideNav club-name button — dropdown opens, lists both clubs,
      Lakeview marked as current (checkmark / "Current")
- [ ] Keyboard: focus the trigger via Tab, open with Enter/Space, confirm
      the list items are reachable and each has an accessible role/label
- [ ] Select Generic Club — button shows "Switching…", repeated clicks
      during the switch have no additional effect
- [ ] Confirm redirect to `/calendar`
- [ ] Confirm SideNav/BottomNav now show "Generic Club" and Member-level
      navigation (no Lessons tab, no `/admin/*` links)
- [ ] Confirm the page theme matches Generic Club's `theme_key`

## 4. Generic Member → Lakeview Pro (switch back)

- [ ] Repeat via either the desktop dropdown or the mobile sheet
- [ ] Confirm redirect to `/calendar`, SideNav/BottomNav now show "Lakeview
      Test Club" and Pro-level navigation (Lessons tab visible)
- [ ] Confirm theme matches Lakeview's `theme_key`

## 5. Mobile switcher

- [ ] Open the More sheet, tap "Switch club" — the More sheet closes and a
      new "Switch Club" sheet opens with the same list/behavior as desktop
- [ ] Select the other club — sheet dismisses (via the redirect/navigation),
      lands on `/calendar` with the new club active

## 6. Profile membership list

- [ ] From `/profile`'s Clubs section, select the non-current club —
      confirms the same shared component/action switches correctly and
      redirects to `/calendar`
- [ ] Confirm the current-club marker updates correctly after switching

## 7. Club name / theme / nav / data isolation after each switch

For each switch performed above:
- [ ] Calendar shows only the newly-active club's courts/reservations
- [ ] Events shows only the newly-active club's events
- [ ] Bookings (`/my-schedule`) shows only the newly-active club's
      reservations/signups — no bleed-through from the other club
- [ ] Admin navigation appears only when the newly-active club's role is
      admin (it should not for this Member/Pro pair, but re-confirm if
      testing with an Admin-role second membership)

## 8. Invalid target rejection

- [ ] Attempt to call the switch action / RPC with a club id the account
      has no membership in at all — confirm a safe, generic error is shown
      (no crash, no partial switch, `active_club_id` unchanged)
- [ ] Confirm no page anywhere reveals *which* other club exists or that a
      membership check even occurred beyond the generic error

## 9. Inactive/suspended/removed memberships never appear

- [ ] **[SQL]** Temporarily set the disposable account's Generic Club
      membership to `status = 'inactive'`
- [ ] Confirm Generic Club no longer appears in the desktop dropdown, the
      mobile sheet, or the `/profile` Clubs section — and if this was the
      only other membership, the switcher disappears entirely (falls back
      to the one-club static display)
- [ ] **[SQL]** Repeat for `status = 'suspended'`, and again for `removed_at`
      set — same result in all three cases
- [ ] **[SQL]** Restore Generic Club to `status = 'active'`, `removed_at =
      null` when done

## 10. No membership administration

- [ ] Confirm no control anywhere in the switcher (desktop, mobile, or
      profile) offers to leave, remove, deactivate, or reactivate a
      membership — selecting a row only ever switches to it

## 11. No stale-tab warning (explicitly out of scope for 26E1)

- [ ] Open the app in two tabs, switch clubs in one — confirm the other tab
      shows no warning/banner (none exists yet; this is Phase 26E2's job).
      This is a confirm-the-absence check, not a defect if no warning
      appears

## 12. Mobile header club icon — anchored popover entry point

Unlike More → "Switch club" (a full-width `BottomSheet`, unchanged), the
top-left header icon opens a small **anchored popover card** directly below
the button — not a pull-up sheet. Both surfaces render the same
`ClubMembershipList` and go through the same `switchActiveClubAction`.

- [ ] As the two-club disposable account, on mobile, tap the club icon in
      the top-left of the header (any page) — confirm a floating card opens
      anchored directly below the button, not a bottom sheet
- [ ] Confirm both clubs and the current-club marker are fully visible in
      the popover, matching what More → "Switch club" shows
- [ ] Confirm the popover stays within the left/right viewport edges at
      common mobile widths, and is not covered by or overlapping the fixed
      bottom navigation or the floating "+ Event" control (e.g. on Calendar)
- [ ] Select the other club — confirm the switch succeeds and redirects to
      `/calendar`, same as every other entry point
- [ ] Tap outside the popover — confirm it closes
- [ ] Open it and press Escape — confirm it closes
- [ ] Re-confirm More → "Switch club" still opens its existing full-width
      `BottomSheet` unchanged and still works
- [ ] Sign in as a one-club Member/Pro/Admin — confirm the header club icon
      is not interactive (no chevron, tapping it does nothing) — identical
      to pre-26E1 appearance and behavior
- [ ] Confirm desktop is unaffected (SideNav's own dropdown switcher,
      unchanged)
