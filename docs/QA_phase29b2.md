# Phase 29B2 — Remaining Sheet Unification, Calendar Action Menu, and Calendar Scroll Stabilization — Manual QA

Scope: every sheet still `mobileInteraction="static"` at the end of Phase
29B1 has now migrated to `"draggable"` (or been given `header={null}` where a
full header extraction would have required redesigning content), all three
`BottomSheet` consumers now use `ResponsiveSheet` directly and `BottomSheet.tsx`
has been deleted, the calendar's two stacked `+ Event`/`+ Block` buttons have
been replaced with one role-based `CalendarFab` popover, and the calendar
grid's horizontal-scroll snap/recenter defect has a targeted fix. This
document assumes Phase 29B1's foundation (real touch events, Pointer Events
mouse fallback, two-layer entrance/drag split, dedicated handle strip,
drag-to-dismiss/spring-back, backdrop fade, reduced-motion timing, focus trap
+ restoration, Escape, inert/aria-hidden nested-parent suspension,
reference-counted body-scroll lock) is already verified — see
`QA_phase29b1.md` for that mechanics-level pass. This document focuses on
**coverage**: every consumer that was still static before now behaves the
same way, plus the two net-new pieces of UI (the calendar FAB and the scroll
fix).

Run on a real iPhone (Safari) and at least one real Android device (Chrome)
where available — desktop responsive mode does not reliably reproduce touch
gesture, dynamic-viewport, or VoiceOver/TalkBack behavior.

---

## 1. Newly migrated sheets — drag, Escape, focus, backdrop

For **each** of the sheets below: open it, confirm the handle strip drags it
(short drag springs back, longer drag/flick dismisses), confirm desktop
`Escape` closes it, confirm desktop backdrop click closes it, confirm focus
returns to the opening control on close, and confirm reduced-motion mode
closes it instantly with no stuck frame (same checks as 29B1 §1–§4, §8–§12,
applied per-sheet here rather than repeated in full):

- [ ] `CreateEventSheet` (Events → Create, and via the calendar slot-action
      sheet's "Create Event") — all 4 steps; the in-sheet "← Back" (step > 1)
      and the sheet-level `onBack` (step 1, from the slot-action sheet) both
      still work as ordinary taps, never captured by the drag gesture.
- [ ] `CreateMaintenanceSheet` (via the calendar slot-action sheet's
      "Maintenance Block") — Back button behaves the same way.
- [ ] `ReservationDetailSheet` (tapping an existing reservation on the
      calendar) — `header={null}`, decorative-looking title now lives in the
      scrollable body; confirm the handle strip alone still drags it (there
      is no separate header row to accidentally grab).
- [ ] `AddMemberSheet` (Admin → Members → Add) — both create and edit modes;
      the conditional back-arrow and mobile Close button both work as
      ordinary taps.
- [ ] `InviteSheet` (Admin → Members → Invite) — both the "Send Invite" step
      and the "Invite Link Ready" step (title in header changes between the
      two — confirm it updates correctly).
- [ ] `ImportMembersSheet` (Admin → Members → Import) — `header={null}`;
      confirm dragging the handle strip does not interfere with any of the
      5 wizard steps' own per-step headers/controls underneath it.
- [ ] `AdminRequestLessonSheet` (Admin → Lessons → Create Request).
- [ ] `RequestLessonSheet` (Lessons → Request a Lesson, member-facing).
- [ ] `LessonRequestDetail` (tapping a lesson request).
- [ ] `LessonProSheet` (pro's lesson request action sheet).
- [ ] `ProgramPreviewSheet` (Events → Programs → preview/generate) — header
      is a two-part fragment (nav row + title); confirm both render and
      neither is draggable on its own (only the handle strip is).
- [ ] `ProgramRosterSheet` (Events → Programs → roster) — `variant="panel"`;
      confirm panel sizing/positioning still looks correct on desktop.

## 2. Event Details → Event Roster nesting (EventRosterSheet's own accessibility)

Phase 29B1 explicitly deferred `EventRosterSheet`'s own mobile Escape, focus
trap, and focus restoration (see `QA_phase29b1.md` §9b). It is now migrated
and owns these directly.

- [ ] Open **EventDetailSheet**, then "View Roster" (admin/pro only).
- [ ] On mobile: the roster sheet has its own visible drag handle strip,
      layered visually above `EventDetailSheet` (no z-index collision, no
      double backdrop).
- [ ] On mobile: press a hardware/software back gesture or however Escape-
      equivalent applies — N/A if the platform has no such gesture; skip to
      next check.
- [ ] On desktop: pressing `Escape` while the roster is open closes **only**
      the roster sheet; `EventDetailSheet` remains open underneath.
- [ ] `Tab`/`Shift+Tab` cycles only within the roster sheet while it's open —
      never reaches `EventDetailSheet`'s controls underneath.
- [ ] Closing the roster sheet (drag-dismiss on mobile, Escape/backdrop on
      desktop, or its own Close control) returns focus to `EventDetailSheet`'s
      "View Roster" button, and `EventDetailSheet` immediately regains its
      own working Escape/backdrop/focus-trap/drag.
- [ ] Confirm there is only **one** drag engine active at a time — dragging
      the roster sheet's handle never also moves `EventDetailSheet` behind
      it, and `EventDetailSheet` stays `inert`/non-interactive the whole time
      the roster is open (matches 29B1 §9a, now true because both sides of
      the pair are draggable).

## 3. Calendar slot flow — booking continuation, Create Event, Maintenance Block

- [ ] Tap an empty calendar slot to open the slot-action sheet. Confirm it
      still drags/dismisses/Escapes as before (unchanged from 29B1).
- [ ] Choose **"Book Court"** — confirm the booking-continuation sheet
      replaces the slot-action sheet with no leftover backdrop and no stale
      body-scroll lock (background does not scroll while it's open, and
      scrolls normally again after it's fully closed). Confirm its own
      handle strip drags it, and the "← Back" button (shown when it was
      reached via the slot-action sheet) returns to the slot-action sheet
      correctly, with drag/Escape working again immediately on return.
      Confirm the court name + date/time summary render correctly in the
      header/body as before.
- [ ] Choose **"Create Event"** — confirm `CreateEventSheet` opens (step 1,
      pre-filled from the slot) with a working "← Back" that returns to the
      slot-action sheet, no duplicate backdrop, no stale body lock.
- [ ] Choose **"Maintenance Block"** (admin only) — same checks as above for
      `CreateMaintenanceSheet`.
- [ ] From each of the three destinations, close via drag-dismiss (mobile)
      and via Escape/backdrop (desktop) instead of "← Back" — confirm focus
      correctly returns to the calendar slot that was originally tapped, not
      lost to `<body>`.
- [ ] Repeat the whole slot → each of the three destinations → back-or-close
      cycle 2–3 times in a row — no duplicate handle strips, no accumulating
      backdrops, no growing body-scroll-lock count that fails to release
      (background scroll must work normally after the last one closes).

## 4. BottomNav and Notifications — post-migration parity

`BottomSheet.tsx` has been deleted; `BottomNav`'s "More" and "Switch club"
sheets and `NotificationSheet` (mobile) now render via `ResponsiveSheet`
directly. Confirm no regression:

- [ ] **More** sheet (bottom nav → More): opens, drags to dismiss, lists all
      role-appropriate links, tapping a link closes the sheet and navigates.
      If the user has 2+ club memberships, the club-name header row and
      "Switch club" control both render and work.
- [ ] **Switch club** sheet (from More → "Switch club"): opens with
      `header={null}` (title lives in the body), lists memberships, closing
      it (drag, Escape, or backdrop) works and does not also close/reopen
      More unexpectedly.
- [ ] **NotificationSheet**, mobile viewport: opens via the bell icon, drags
      to dismiss, "Mark all read" (when unread items exist) works, tapping a
      notification with a safe `target_path` navigates and closes the sheet.
      Confirm the list scrolls independently within the sheet's bounded
      height (no more separate `max-h-[55vh]` wrapper — `ResponsiveSheet`'s
      own scroll region now owns this) with no double-scrollbar or clipped
      last item.
- [ ] **NotificationSheet**, desktop viewport: confirm the desktop anchored
      dropdown (unchanged, not a `ResponsiveSheet`/`BottomSheet` consumer)
      still opens/closes/scrolls exactly as before — this branch was
      intentionally left untouched.
- [ ] Confirm `src/components/BottomSheet.tsx` no longer exists in the
      codebase and nothing imports it (only historical comments in
      `HeaderClubSwitcherButton.tsx` and `ResponsiveSheet.tsx` mention it by
      name, as design-rationale text, not imports).

## 5. Role-based Calendar floating + menu

Replaces the old stacked `+ Block`/`+ Event` buttons with one `CalendarFab`.

- [ ] **Admin**: the calendar shows exactly one circular `+` button (no
      separate stacked buttons). Tapping it opens a menu with **exactly two**
      options: "Create Event" and "Maintenance Block" — in that order, no
      "Book Court", no "Create Program".
- [ ] **Pro**: the `+` button's menu has **exactly one** option: "Create
      Event" — no "Maintenance Block", no "Book Court", no "Create Program".
- [ ] **Member**: no `+` button renders on the calendar at all. Booking still
      works only by tapping an available slot (unchanged flow).
- [ ] Selecting a menu option closes the menu and opens the corresponding
      sheet (`CreateEventSheet` with `creatingEvent=true` / maintenance
      sheet with `creatingBlock=true`) — same sheets as reached from other
      entry points, no divergent behavior.
- [ ] Clicking anywhere outside the open menu closes it and returns keyboard
      focus to the `+` button.
- [ ] Pressing `Escape` while the menu is open closes it and returns
      keyboard focus to the `+` button.
- [ ] Selecting an item (click or keyboard activation) closes the menu and
      opens its sheet — focus lands wherever that sheet's own dialog focus
      management puts it (its first focusable control / panel), **not**
      back on the `+` button. The `+` button is only re-focused by Escape or
      backdrop-click, never by a successful selection.

### 5a. CalendarFab keyboard model (roving focus, hand-rolled — no menu library)

- [ ] Opening the menu with a keyboard (Tab to the `+` button, Enter or
      Space) moves focus straight to the **first** menu item.
- [ ] `ArrowDown` moves focus to the next item; from the last item it wraps
      to the first.
- [ ] `ArrowUp` moves focus to the previous item; from the first item it
      wraps to the last.
- [ ] `Home` moves focus to the first item regardless of current position.
- [ ] `End` moves focus to the last item regardless of current position.
- [ ] `Tab` from any item moves to the next item, wrapping from the last back
      to the first — it does **not** leave the menu for the backdrop or page
      content behind it.
- [ ] `Shift+Tab` from any item moves to the previous item, wrapping from the
      first back to the last — same containment guarantee.
- [ ] For the **admin** menu (2 items): confirm the full wrap cycle in both
      directions (`ArrowDown` × 2 returns to item 1; `ArrowUp` × 2 returns to
      item 1) lands on the expected item each time.
- [ ] For the **pro** menu (1 item): confirm `ArrowDown`, `ArrowUp`, `Tab`,
      and `Shift+Tab` all keep focus on the single item (a one-item wrap is a
      no-op, not an error/freeze).
- [ ] Close the menu (Escape, backdrop click, or selecting an item) and
      reopen it — confirm focus lands on the first item again each time (no
      stale "last focused index" carried over between opens).
- [ ] With the menu open, inspect via devtools that exactly one
      `document`-level `keydown` listener from `CalendarFab` is active;
      after closing (any method) or navigating away from Calendar, confirm
      it is removed (no listener leak across repeated open/close cycles).
- [ ] The `+` button and its menu are visible and legible in both light and
      dark mode.
- [ ] On mobile, the `+` button sits clear of the bottom nav and the safe-
      area inset, and does not obscure the last visible time row/court
      column when the menu is closed.
- [ ] The menu opens above/adjacent to the button (never off-screen) at both
      a narrow mobile width and a wide desktop width.
- [ ] `+` button has an accessible name (confirm via screen reader or
      devtools accessibility tree: `aria-label="Create"`), and the menu
      itself exposes `role="menu"`/`aria-label` with `role="menuitem"` on
      each option.
- [ ] No leftover old "+ Block" / "+ Event" buttons remain anywhere on the
      calendar.

## 6. Calendar horizontal scroll stabilization

The grid container (`gridContainerRef`) scrolls both directions natively.
Column width (`colW`) is recomputed on mount and on every `ResizeObserver`
firing (container resize, e.g. mobile Safari's address bar collapsing/
expanding, or orientation change).

The fix is keyed off an explicit `calendarContextKey` — `clubId` +
club-local `selectedISO` date + the ordered list of currently visible court
IDs, joined into one string — computed fresh every render and compared
against a ref holding its previous value. **Any** change to that key (club,
date, or the visible court set, including a court-filter toggle) is treated
identically: scrollLeft resets to 0 exactly once, and any pending
ratio-restoration is cleared first so it can never fire against stale data
afterward. When the key is unchanged but `colW` changes anyway (a same-context
resize), the scroll position is preserved as a ratio and re-applied against
the new column width once it's actually painted. See the comment block above
the effect in `CalendarShell.tsx` for the exact logic — this replaces an
earlier, less precise version of this fix that reset only on a raw
court-*count* change, which could miss a same-court-count club switch or
misattribute a date change.

- [ ] On a club/date with enough courts to require horizontal scrolling,
      manually scroll the grid right so a middle/last court is visible.
- [ ] Open any sheet from the calendar (an event, a slot, the FAB menu) and
      close it again — confirm the grid's horizontal scroll position is
      **unchanged** after the sheet closes (no snap back toward court 1).
      Club, date, and visible-court-set are all untouched by opening/closing
      a sheet, so `calendarContextKey` cannot change from this alone.
- [ ] With the grid scrolled right, trigger an action that updates calendar
      data without changing the date/club/court filter — e.g. create a
      booking, then watch the grid re-render with the new reservation block —
      confirm the horizontal scroll position does not jump.
- [ ] Same-context resize: with the grid scrolled right, resize a desktop
      browser window (drag the window edge) without changing club, date, or
      court filter — confirm the scroll position adjusts smoothly/
      proportionally (ratio-preserved) rather than snapping to 0 or clamping
      abruptly.
- [ ] On mobile, with the grid scrolled right, trigger the browser chrome to
      collapse/expand (scroll the page slightly, or rotate and rotate back)
      so the address bar shows/hides — confirm the grid does **not** snap
      back to the left edge when this happens mid-interaction (same-context
      incidental resize, not a reset).
- [ ] Rotate the device (portrait ↔ landscape) while scrolled right —
      confirm the previously-visible court stays reasonably close to visible
      after rotation (position may shift slightly since available width
      changed, but should not hard-reset to the far left — rotation alone
      never changes `calendarContextKey`).
- [ ] Change the selected **date** — confirm the grid **always** resets to
      the left edge (scrollLeft 0), even on a day whose visible court set
      happens to be identical to the previous day's. This is the one
      explicit, documented date-change rule: any date change resets,
      unconditionally, regardless of whether the court count or set also
      changed.
- [ ] Switch to a **different club that has the same number of visible
      courts** as the current one (multi-club testing) — confirm the grid
      **still** resets to the left edge. This is the case the corrected fix
      specifically targets: a same-court-*count* club switch must not be
      mistaken for "nothing changed" just because the count matches.
- [ ] Toggle the court filter (deselect/reselect a court, or "Select All")
      so the *set* of visible court IDs changes but the *count* happens to
      stay the same — confirm the grid resets to the left edge for this too
      (the key is built from the ordered ID list, not just the count).
- [ ] After any of the above resets, scroll right again and confirm no
      stale ratio-restoration fires unexpectedly on the next incidental
      resize — i.e. a reset fully clears prior scroll-preservation state
      rather than leaving a leftover ratio to be applied against the new
      context's column width.
- [ ] Confirm mobile momentum ("flick") scrolling on the grid still feels
      native and smooth — the fix does not intercept or replace native
      scroll, only corrects `scrollLeft` after legitimate `colW` changes.
- [ ] Confirm there is no periodic/looping scroll correction — e.g. leave
      the calendar open and idle for 30+ seconds after scrolling right; the
      position must not drift or auto-correct with no user or data action.

## 7. Reduced motion, portrait/landscape, iOS/Android — spot-check

Repeat a representative subset (not the full matrix) of Phase 29B1 §12–§14
on 2–3 of the newly migrated sheets (e.g. `CreateEventSheet`,
`AddMemberSheet`, `NotificationSheet`) to confirm the shared foundation
behaves identically for these new consumers:

- [ ] Reduced-motion: dismiss is instant, no stuck frame, backdrop fades
      (not flashes) out.
- [ ] Portrait and landscape: sheet stays correctly bounded, no cut-off
      content, no stuck transform after rotating with a sheet open.
- [ ] iOS Safari and one Android/Chrome device: no correctness regressions
      (stuck sheets, unreachable content, focus escaping) — feel differences
      (flick velocity, keyboard-resize timing) are expected and fine.

## 8. Repeated open/close stress pass

- [ ] Pick any 2 of the newly migrated sheets plus the calendar FAB menu.
      Open and close each one 5+ times in a row (mixing drag-dismiss,
      Escape, and backdrop click as the close method). Confirm: no
      duplicate handle strips ever appear, no duplicate/stacking backdrops,
      body scroll is always restored after the last close, and focus never
      ends up lost to `<body>`.

---

## Known/expected limitations of this checkpoint

- `ImportMembersSheet` and `ReservationDetailSheet` use `header={null}` —
  their content was judged too varied (5-step wizard) or too simple (a
  single detail block) to safely restructure into the shared header pattern
  without redesigning content, which was explicitly out of scope. The
  handle-strip-only drag surface still applies; this is a deliberate,
  conservative choice, not an oversight.
- `NotificationSheet`'s desktop anchored-dropdown branch is untouched — it
  was never a `BottomSheet`/`ResponsiveSheet` consumer, and unifying its
  visual presentation with the mobile sheet would be a redesign beyond this
  checkpoint's scope.
- No new scheduling-edit parity, no generic "Book Court" form, and no
  "Create Program" entry were added to the calendar FAB — these were
  explicitly excluded by the checkpoint's constraints, not deferred bugs.
- The scroll-stabilization fix only guards `colW`-driven horizontal
  repositioning inside the existing `ResizeObserver`/`useLayoutEffect`; it
  does not add any new scroll-restoration behavior (e.g. remembering scroll
  position across a full date/club navigation) beyond what's described in
  §6 — a genuine context reset intentionally returns to the left edge.
