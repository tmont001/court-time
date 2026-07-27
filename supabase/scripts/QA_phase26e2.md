# Phase 26E2 QA Checklist — Stale Active-Club Tab Protection

Covers Phase 26E2: no database changes (uses the existing
`get_current_account_context()` RPC and `set_active_club()` foundation
unmodified). Application changes: `switchClubAction.ts`,
`ClubMembershipList.tsx`, `activeClubChannel.ts` (new),
`StaleActiveClubGuard.tsx` (new), `StaleActiveClubOverlay.tsx` (new),
`(app)/layout.tsx`. Requires migrations `0081`-`0085` already applied and
verified, and Phase 26E1's switcher (desktop, mobile header popover, mobile
More sheet, Profile) passing.

**Scope reminder:** this checkpoint detects staleness and blocks the tab. It
does not add `expected_club_id` guards to individual mutations — see the
Phase 26E2 report for the audit that found no automatic (non-user-initiated)
club-scoped mutation in the current codebase, and the explicit note on what
race remains for Phase 26F.

Use the existing disposable two-club test account (**Generic Club**: Member,
**Lakeview Test Club**: Pro).

---

## Pre-conditions

- [ ] Migrations `0081`-`0085` applied and previously verified
- [ ] No new migration exists or is required for this checkpoint
- [ ] Phase 26E1 QA (`QA_phase26e1.md`) previously passing

---

## 1. Two tabs, cross-tab detection (desktop)

- [ ] Open the app in two browser tabs (Tab A, Tab B), both signed in as the
      two-club account, both currently showing **Lakeview** active
- [ ] In Tab A, switch to **Generic Club** via any switcher entry point
- [ ] Confirm Tab A itself shows **no** stale warning at any point — it
      switches cleanly and lands on `/calendar` showing Generic Club
- [ ] Bring Tab B to the foreground (click into it) — confirm the blocking
      overlay appears **immediately** (before any further interaction),
      titled "Your active club changed", mentioning Generic Club by name
- [ ] Confirm Tab B's Calendar, Events, Bookings, Lessons, and (if
      applicable) Admin controls underneath are not clickable/keyboard-
      reachable while the overlay is showing
- [ ] Click "Load current club" in Tab B — confirm a full page reload lands
      on `/calendar` showing Generic Club, matching Tab A

## 2. Repeat in the other direction

- [ ] With both tabs now on Generic Club, switch Tab B back to Lakeview
- [ ] Confirm Tab A becomes blocked on next foreground/focus, showing
      "Lakeview Test Club" as the new active club
- [ ] "Load current club" in Tab A restores parity

## 3. Background tab, foreground detection without a click

- [ ] With Tab B in the background (not focused, but not fully closed),
      switch clubs in Tab A
- [ ] Switch to Tab B via OS/browser tab-switching (not necessarily clicking
      inside the page) — confirm the overlay appears as soon as Tab B
      becomes the visible/focused tab, without needing an in-page click

## 4. localStorage fallback (where practical to test)

- [ ] If feasible in your test environment, disable/simulate the absence of
      `BroadcastChannel` (e.g. via devtools override or a browser without
      support) and repeat check 1 — confirm the `storage`-event fallback
      still triggers detection in the other tab within one focus/visibility
      cycle

## 5. No false positives

- [ ] Switching clubs within a single tab never shows the stale overlay in
      that same tab, in either direction, repeated several times
- [ ] Trigger a **failed** switch attempt (e.g. simulate `invalid_active_club`
      by racing a deactivation — see Phase 26E1's disposable-membership
      tests) — confirm no other open tab shows a stale warning as a result
      of the failed attempt

## 6. One-club accounts unaffected

- [ ] Sign in as an existing one-club Member/Pro/Admin — confirm no stale
      overlay ever appears under normal use (no switcher exists for this
      account, so no legitimate trigger exists, and the guard's live check
      — if ever triggered by focus/visibility — correctly reports "current"
      every time since nothing changed)

## 7. Active membership becoming inactive/null

- [ ] **[SQL]** While the two-club account has Tab A open on Lakeview, set
      the Lakeview `club_memberships` row to `status = 'inactive'` directly
      (simulating an admin deactivating this membership from elsewhere)
- [ ] Bring Tab A to the foreground — confirm the blocking overlay appears
      with "Your club access changed" / no-longer-active copy, not the
      "changed in another tab" copy
- [ ] "Load current club" reloads into whatever state the account now
      resolves to (the other active membership, or the pending-invite/no-
      club state, per the existing layout redirect logic — no new routing
      was added)
- [ ] **[SQL]** Restore Lakeview to `status = 'active'` when done

## 8. Expired authentication

- [ ] Simulate an expired/invalidated session (e.g. revoke the session
      server-side or clear the auth cookie while the tab is open) and bring
      the tab to the foreground — confirm it follows the existing sign-in
      redirect behavior (lands on `/sign-in`), not a stale-club-specific
      dialog

## 9. Network/check failure

- [ ] Simulate the freshness check failing (e.g. block the
      `get_current_account_context` request in devtools) and trigger a
      check via focus/visibility — confirm a blocking "couldn't confirm"
      state appears with a "Retry" action, and the tab is **not** silently
      treated as current
- [ ] Restore the network and click "Retry" — confirm it resolves correctly
      (to "current" or "stale" as actually applicable)

## 10. Accessibility

- [ ] When the overlay appears, confirm focus moves into it (the primary
      button is focused)
- [ ] Confirm Tab does not move focus to anything outside the dialog while
      it is open
- [ ] Confirm Escape does not dismiss the overlay
- [ ] Confirm a screen reader announces the dialog's title/description
      (`role="alertdialog"`, `aria-modal`, `aria-labelledby`/
      `aria-describedby`)

## 11. Mobile and desktop

- [ ] Repeat checks 1-2 on a mobile viewport/device — confirm the overlay
      renders correctly above the fixed bottom navigation and any floating
      controls (e.g. Calendar's "+ Event" button), and "Load current club"
      works the same way
- [ ] Confirm desktop behavior throughout (SideNav dropdown switcher,
      overlay layering, focus trap) is unaffected in shape from Phase 26E1

## 12. Existing switcher entry points still work

- [ ] Desktop SideNav dropdown — switches correctly, no regressions
- [ ] Mobile header popover — switches correctly, no regressions
- [ ] Mobile More → "Switch club" sheet — switches correctly, no
      regressions
- [ ] `/profile` Clubs section — switches correctly, no regressions
- [ ] All four still result in cross-tab notification to other open tabs
