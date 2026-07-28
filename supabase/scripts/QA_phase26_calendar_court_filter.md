# Phase 26 Calendar Fix QA Notes — Club-Switch Stabilization

Covers two targeted fixes:

- `src/app/(app)/calendar/CalendarShell.tsx`: `selectedCourtIds` was only
  initialized on mount, so switching the active club (new `clubId`/`courts`
  props on an already-mounted `CalendarShell`) left the old club's court IDs
  selected, matching nothing in the new court list and showing an empty
  calendar until Select All or a manual court click.
- `src/components/ClubMembershipList.tsx`: a successful switch used
  `router.push("/calendar")` + `router.refresh()`, which — since the app may
  already be on `/calendar` — could preserve mounted client component state
  across the "navigation": the row's own "Switching…" state never cleared,
  and `CalendarShell` could render a beat before its new `clubId`/`courts`
  props arrived. The successful-switch path now calls
  `publishActiveClubChanged()` followed by a full browser navigation
  (`window.location.assign("/calendar")`), guaranteeing a fresh page load
  and a fresh component tree every time. Failed switches are unaffected —
  they still set an inline error and clear "Switching…" without navigating.

No data fetching, database objects, RPCs, or club-switching/stale-tab logic
changed.

---

1. **Generic → Lakeview immediately displays Lakeview courts.**
   Switch active club from Generic to Lakeview and land on `/calendar` —
   confirm Lakeview's courts appear in the grid immediately, no empty state,
   no manual Select All / court click required.

2. **Lakeview → Generic immediately displays Generic courts.**
   Switch back — confirm the same, in the reverse direction.

3. **Repeat switching several times.**
   Switch back and forth (Generic → Lakeview → Generic → Lakeview) at least
   4–5 times — confirm the grid populates correctly every time, with no
   occasional empty-state flash.

4. **Manual individual-court selection still works within one club.**
   Without switching clubs, click individual court filter chips to
   toggle them on/off — confirm the grid updates to show only the selected
   courts, same as before this fix.

5. **Select All still works.**
   Within one club, deselect a court, then click "Select All" — confirm all
   courts reselect and the button toggles to "Deselect all". Click again —
   confirm all courts deselect (grid legitimately shows no courts, this is
   the deliberate empty state and must not be silently overridden).

6. **No previous-club court ID remains selected.**
   After switching clubs, confirm no court chip from the prior club is
   rendered or implicitly selected — the filter chip row shows only the new
   club's courts, all selected by default.

---

## Switch-navigation stabilization (ClubMembershipList)

7. **"Switching…" disappears after the new club loads.**
   Click a non-active club row — confirm the row briefly shows "Switching…"
   and, once the full-page navigation to `/calendar` completes, the switcher
   UI (re-opened) no longer shows "Switching…" anywhere.

8. **The active row shows "Current", never lingering "Switching…".**
   After a switch completes, reopen the switcher (desktop dropdown, mobile
   header popover, mobile bottom sheet, and `/profile` Clubs section) —
   confirm the newly active club row shows "✓ Current" and no row is stuck
   showing "Switching…".

9. **Courts populate on the first switch in both directions.**
   From a fresh sign-in (not just a later switch in the session), switch
   Generic → Lakeview — confirm Lakeview's courts appear immediately on the
   very first switch, not just on subsequent ones. Repeat starting from
   Lakeview → Generic.

10. **Repeat Generic ↔ Lakeview at least five times.**
    Switch back and forth at least five times in a row — confirm every
    switch fully reloads `/calendar` with the correct courts and no row is
    ever left showing stale "Switching…" or a stale "✓ Current".

11. **Desktop and mobile switchers behave identically.**
    Repeat the switch on desktop (SideNav dropdown), the mobile header
    popover, the mobile bottom sheet (BottomNav), and the `/profile` Clubs
    section — confirm identical behavior on every surface, since all four
    render the same `ClubMembershipList`.

12. **Browser Back does not leave an interactive stale-club page.**
    After switching clubs, press the browser Back button — confirm the
    prior page either reloads correctly or is caught by the existing Phase
    26E2 stale-tab protection (blocking overlay / forced reload) rather than
    being left as an interactive page still showing the old club's data.
