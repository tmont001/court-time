# Phase 29B1 — Draggable & Accessible Sheet Foundation — Manual QA

Scope: the new `mobileInteraction="draggable"` mode in `ResponsiveSheet.tsx`,
enabled on exactly three consumers:

1. **CreateProgramSheet** — tall multi-step form, internal scrolling, native
   date/time controls, a back button in the header.
2. **EventDetailSheet** — medium detail/action sheet (join/leave/waitlist
   actions), nests `EventRosterSheet` (non-migrated) via "View Roster".
3. **CalendarShell slot-action sheet** — short sheet opened by tapping an
   empty time slot (Book Court / Create Event / Maintenance Block).

All other sheets — `InviteSheet`, `AddMemberSheet`, `EventRosterSheet`,
`CreateEventSheet`, `CreateMaintenanceSheet`, `ReservationDetailSheet`,
`ProgramPreviewSheet`, `ProgramRosterSheet`, `RequestLessonSheet`,
`LessonRequestDetail`, `AdminRequestLessonSheet`, `ImportMembersSheet`,
`LessonProSheet`, `CalendarShell`'s **booking-continuation sheet** (the
duration picker shown after choosing "Book Court"), and the two consumers
that open from the slot-action sheet — `CreateEventSheet` (via "Create
Event") and `CreateMaintenanceSheet` (via "Maintenance Block") — plus
everything on `BottomSheet` (`BottomNav`'s two sheets and
`NotificationSheet`) — are **intentionally, unchanged static-mode
consumers**, not Phase 29B1 defects. `mobileInteraction` defaults to
`"static"` for all of them; they were never in scope for this checkpoint's
drag/accessibility work and none of the checks below apply to them except
the regression spot-check in §16. Only the three listed above (Create
Program, Event Detail, and specifically the calendar's *initial* slot-action
sheet — the one offering "Book Court / Create Event / Maintenance Block" —
not any sheet reached by tapping one of those three options) are enabled.

### Implementation summary (read before testing)

- **Mobile gesture — real touch events, not Pointer Events.** The
  drag-handle strip registers `touchstart`/`touchmove`/`touchend`/
  `touchcancel` via `addEventListener` directly on its DOM node (ported from
  `BottomSheet.tsx`'s proven mechanics), with `touchmove` registered
  non-passive so `preventDefault()` can suppress native scroll during a
  drag. This is the path real iPhone/Android touch input uses.
- **Mouse fallback — Pointer Events, non-touch input only.** The same handle
  strip also has `onPointerDown/Move/Up/Cancel` (Pointer Events, via JSX
  props) for mouse-driven dragging when testing in a desktop browser's
  device-emulation mode with a mouse. Every one of these handlers exits
  immediately when `e.pointerType === "touch"`, so real touch input always
  goes through the native listeners above — the two paths never run for the
  same gesture.
- **Two DOM layers, not one.** The mobile panel is now an *outer wrapper*
  (owns the `ct-sheet-enter` entrance animation, fixed positioning,
  z-index, and max-height) containing a separate *inner panel* (owns the
  drag `transform`, the handle strip, header, scrollable body, and dialog
  semantics). Drag and the entrance animation never touch the same
  element's `transform`, so there's no cascade conflict between them and no
  animation-cancellation workaround is needed.

Run on a real iPhone (Safari) and at least one real Android device (Chrome)
where available — desktop responsive mode does not reliably reproduce touch
gesture, dynamic-viewport, or VoiceOver/TalkBack behavior.

---

## 1. Slow drag below the dismiss threshold

For each of the 3 migrated sheets: open it, press and slowly drag the small
handle strip at the very top of the panel (the pill, in its own full-width
band above the header/title) down by roughly half the panel's height but
release before it feels "committed" (well under ~100px of movement).

- [ ] The panel visibly follows your finger as you drag.
- [ ] The backdrop visibly dims further (reduced opacity) as you drag down.
- [ ] On release, the panel springs back to fully open with a smooth
      (non-jarring) animation.
- [ ] The sheet does **not** close.

## 2. Drag beyond the dismiss threshold

Same 3 sheets: drag down slowly but past roughly a third of the panel's
height, then release.

- [ ] The sheet animates off-screen and closes.
- [ ] The backdrop visibly fades out (toward fully transparent) during the
      close animation — it does **not** snap or flash back to its normal
      darker look at any point while dismissing.
- [ ] The underlying page (calendar / events list) is interactive again
      immediately after close — no leftover invisible backdrop blocking taps.

## 3. Quick downward flick

Same 3 sheets: perform a fast, short downward flick on the handle strip
(small distance, high velocity) rather than a slow full-distance drag.

- [ ] The sheet dismisses even though the drag distance was short — velocity
      alone should trigger dismissal.

## 4. Horizontal swipe

Same 3 sheets: drag the handle strip left or right (not down).

- [ ] The sheet does **not** move or dismiss on a purely horizontal swipe.
- [ ] Releasing does not close the sheet.

## 5. Scrolling long Create Program content, and the handle-vs-header split

Open **CreateProgramSheet**, advance to a step with enough content to scroll
(Step 2 with 2+ schedule rules is a good candidate).

- [ ] Dragging a finger *inside the scrollable body* (not the handle strip)
      scrolls the content normally — it does **not** drag/dismiss the sheet.
- [ ] Dragging *only the small handle strip* at the very top of the panel
      (the pill, in its own band above the title row) drags the sheet.
- [ ] Dragging on the title/step-counter row itself, or anywhere else in the
      header below the handle strip, does **not** drag the sheet (only the
      dedicated handle strip owns the gesture).
- [ ] Scrolling to the very top or bottom of the body and continuing to pull
      (a "rubber-band"/overscroll gesture) does **not** accidentally dismiss
      the sheet.
- [ ] The "← Back" button (in the header, below the handle strip) works with
      a normal tap every time on both iOS and Android — confirm a deliberate
      slow press-and-drag starting *on the Back button itself* also does not
      get treated as a sheet drag (it's outside the handle strip's listener
      region entirely, so it should behave like an ordinary button the whole
      time).

## 6. Keyboard open on a lower field

Open **CreateProgramSheet**, navigate to a step with several fields, and
focus a field low in the form (e.g. a schedule rule's Start Time or the last
field before the Continue button).

- [ ] The on-screen keyboard opens without the sheet becoming unreachable —
      you can still see and interact with the focused field.
- [ ] Scrolling with the keyboard open still reaches every field, from the
      first one down to the Continue/submit button.
- [ ] Dismissing the keyboard restores the sheet to its normal bounded
      height with no leftover gap or stale sizing.

## 7. Native date/time/select controls

Within **CreateProgramSheet** (Starts On / Ends On dates, each rule's Day
select and Start Time): 

- [ ] Tapping a date field opens the native iOS/Android date picker normally.
- [ ] Tapping a native `<select>` opens the native picker/wheel normally.
- [ ] None of these controls are intercepted by the drag gesture (only the
      small handle strip above the header owns the gesture; form controls
      live in the scrollable body, entirely outside it).

## 8. Escape on desktop

At a desktop viewport (≥768px), open each of the 3 migrated sheets and press
`Escape`.

- [ ] The sheet closes.
- [ ] For **EventDetailSheet**: open "View Roster" (admin/pro only) so
      `EventRosterSheet` is layered on top, then press `Escape`.
      - [ ] Only the roster sheet closes.
      - [ ] `EventDetailSheet` remains open underneath, and immediately
            regains working `Escape` (see §9a) — pressing `Escape` again now
            closes it too.

## 9. Tab and Shift+Tab focus cycling

At a desktop viewport, open each of the 3 migrated sheets and press `Tab`
repeatedly.

- [ ] Focus moves through every focusable control inside the sheet only —
      it never lands on background page content (nav, header, calendar
      grid) while the sheet is open.
- [ ] Reaching the last focusable element and pressing `Tab` again wraps
      focus back to the first one.
- [ ] Pressing `Shift+Tab` from the first element wraps to the last one.

### 9a. EventDetailSheet → EventRosterSheet — required now

This is the one real nested-sheet case in this checkpoint. **Required
behavior**, testable now:

- [ ] Open **EventDetailSheet**, then open "View Roster" (admin/pro only).
- [ ] With the roster sheet open, inspect `EventDetailSheet`'s panel (e.g.
      via browser devtools, or a screen reader): it should be `inert` and
      `aria-hidden="true"` — unavailable to keyboard and screen-reader
      interaction while the roster sheet is on top.
- [ ] Pressing `Tab` repeatedly cycles only within the roster sheet — it
      never lands back on `EventDetailSheet`'s Close button, action buttons,
      or any other control underneath.
- [ ] Clicking `EventDetailSheet`'s backdrop or pressing `Escape` while the
      roster is open does nothing to `EventDetailSheet` (see §8) — only the
      roster sheet responds.
- [ ] Close the roster sheet (its own × button, or however it closes).
      `EventDetailSheet` remains open, and:
      - [ ] its dialog semantics are restored (no longer `inert`/
            `aria-hidden`),
      - [ ] `Escape`, backdrop click, focus containment, and (on mobile)
            drag-to-dismiss all work again immediately,
      - [ ] keyboard focus lands back on **"View Roster"** (the control that
            opened the nested sheet) if it still exists on the page —
            otherwise on the first available control in `EventDetailSheet`,
            or the panel itself.

### 9b. EventRosterSheet's own accessibility — deferred to Phase 29B2

`EventRosterSheet` itself is **not** migrated in this checkpoint (still
`mobileInteraction="static"`). While it is the open/topmost sheet, do **not**
expect:

- a mobile Escape handler (Escape only closes it on desktop, same as before
  this checkpoint),
- its own focus trap (`Tab` can currently leave the roster sheet for
  background page content while it's open — a pre-existing gap, not
  something this checkpoint touches),
- its own focus-restoration on close beyond what's described in §9a (focus
  returning to `EventDetailSheet`'s "View Roster" button is `EventDetailSheet`'s
  responsibility, handled above; nothing focuses a specific *row* inside the
  roster on its own close).

These three are explicitly deferred to Phase 29B2's full accessibility
migration of `EventRosterSheet` — do not fail this checkpoint's QA over them.

## 10. Backdrop click

At a desktop viewport, open each of the 3 migrated sheets and click outside
the panel (on the dimmed backdrop).

- [ ] The sheet closes.
- [ ] For **EventDetailSheet** with the roster sheet open on top: clicking
      `EventDetailSheet`'s backdrop does nothing (see §9a) — clicking the
      roster sheet's own backdrop closes only the roster sheet.

## 11. Focus return to opener

For each of the 3 migrated sheets, note which element you clicked/tapped to
open it (e.g. a calendar event block, an empty time slot, a "Create Program"
button), then close the sheet via each of: the drag gesture (mobile),
`Escape` (desktop), and backdrop click (desktop).

- [ ] After each close, keyboard focus is back on the element that opened
      the sheet (visible focus ring on desktop) — not lost to `<body>`.
- [ ] For **EventDetailSheet**, also confirm the §9a nested-focus-handoff
      behavior separately from this top-level open/close case — they are
      two different focus paths (opener-of-the-whole-sheet vs.
      opener-of-the-nested-sheet).

## 12. Reduced-motion mode

Enable "Reduce Motion" (iOS: Settings → Accessibility → Motion; Android:
Settings → Accessibility → Remove animations; desktop: OS-level
prefers-reduced-motion) and repeat a drag-to-dismiss and a spring-back on
each of the 3 migrated sheets.

- [ ] The sheet still opens, drags, dismisses, and springs back correctly —
      only the animation *duration* should be effectively instant, not the
      functionality.
- [ ] Dragging past the dismiss threshold and releasing closes the sheet
      **immediately** — there should be no perceptible delay between release
      and the sheet actually closing (the underlying page becomes
      interactive again right away). This is a real timing change, not just
      a visual one: reduced motion skips the ~200ms close delay entirely
      rather than only speeding up the animation that plays during it.
- [ ] No visual glitch or stuck-mid-transform frame.
- [ ] The backdrop fades out during a dismiss — confirm it does **not**
      flash back to its normal (darker) opacity at any point before the
      sheet closes.

## 13. Portrait and landscape

Repeat drag-to-dismiss and scrolling (§1, §2, §5) in landscape orientation
on a real phone for at least one of the 3 sheets.

- [ ] The sheet remains correctly bounded within the viewport (no content
      cut off above the screen, no overflow past the bottom safe area) — the
      outer wrapper and inner panel should both track the new viewport
      height correctly.
- [ ] Rotating the device *while a sheet is open* doesn't leave a stuck
      drag transform on the inner panel or an incorrectly sized outer
      wrapper.

## 14. iOS Safari and Android Chrome

Run the full pass above on both:

- [ ] iOS Safari (real device, not simulator, if available).
- [ ] One Android/Chrome device.

Note any behavioral differences between the two (e.g. flick-velocity feel,
keyboard-resize timing) — differences in *feel* are fine; differences in
*correctness* (stuck sheets, unreachable content, focus escaping) are not.

## 15. Nested / sequential sheet opening

- [ ] Open **EventDetailSheet**, then open "View Roster" — confirm the
      roster sheet visually layers correctly above `EventDetailSheet` (no
      z-index collision) on both mobile and desktop.
- [ ] Close the roster sheet — confirm `EventDetailSheet` is still open,
      fully interactive, and its own drag/Escape/backdrop-dismiss work
      again immediately.
- [ ] From the calendar, open the slot-action sheet, tap "Create Event" —
      confirm the slot-action sheet is replaced by `CreateEventSheet`
      (non-migrated, static mode) with no leftover backdrop/lock from the
      slot-action sheet. Tap "← Back" inside `CreateEventSheet` to return to
      the slot-action sheet — confirm it reopens correctly with drag/Escape
      working again.
- [ ] Open **CreateProgramSheet**, then (without closing it) try to trigger
      page-background scroll (e.g. swipe on the calendar behind it, if
      visible) — confirm the background does not scroll while the sheet is
      open, and scrolls normally again immediately after it closes.

## 16. Regression spot-check of non-migrated sheets

Confirm the following still behave exactly as before this checkpoint (no
drag, no mobile Escape, no focus trap — these are intentionally unchanged):

- [ ] `InviteSheet` or `AddMemberSheet` (admin → Members) — opens, decorative
      handle does not drag, backdrop click closes, desktop Escape works.
- [ ] `EventRosterSheet` — opens (from `EventDetailSheet`'s "View Roster"),
      still layers correctly, admin actions (Force Confirm / Offer Spot /
      Expire / Remove) still work. (Its own accessibility — mobile Escape,
      focus trap — is unchanged/deferred; see §9b. What *is* required now is
      `EventDetailSheet`'s side of this interaction, covered in §9a.)
- [ ] `CalendarShell`'s **booking sheet** (Book Court → duration picker) —
      still opens/closes normally, decorative handle, no drag.
- [ ] `BottomNav`'s "More" sheet and "Switch club" sheet — still drag exactly
      as before (these are `BottomSheet`, untouched by this checkpoint).
- [ ] `NotificationSheet` (mobile) — still drags exactly as before.

---

## Known/expected limitations of this foundation checkpoint

- Only open/dismissed states exist — no intermediate snap points.
- No new dependency was added; drag/focus-trap logic is hand-rolled and
  intentionally minimal (a solid baseline, not a full-featured library).
- Body-scroll-lock does not compensate for the desktop scrollbar
  disappearing (a few pixels of horizontal reflow is possible on some
  browsers) — cosmetic only, not a functional blocker.
- `EventDetailSheet`'s header is intentionally empty (handle-only) — its
  original content was not reorganized into a titled header to avoid any
  redesign of existing sheet content in this checkpoint.
- The drag gesture is owned by a dedicated, non-interactive handle strip (a
  small full-width band with just the pill, above the header) — not the
  whole header/title row. This is a deliberate correction from an earlier
  draft of this checkpoint, made specifically so header controls (e.g.
  CreateProgramSheet's "← Back" button) always receive ordinary tap/click
  behavior and can never be captured by the drag gesture's touch listeners
  or pointer capture (mouse-fallback path).
- The mobile gesture went through two implementation attempts before this
  one: an initial Pointer-Events-only version was replaced with real touch
  events (`touchstart`/`touchmove`/`touchend`/`touchcancel` via
  `addEventListener`, non-passive `touchmove`) after real-device testing
  showed Pointer Events alone did not produce a visible drag on iPhone —
  see the "Implementation summary" above. Pointer Events now exist only as
  a mouse-only fallback for non-touch development testing, explicitly
  bypassed for any `pointerType === "touch"` input. A separate,
  since-resolved issue (the entrance animation and the drag transform
  competing for the same element's `transform`) was fixed by splitting the
  mobile panel into two DOM layers, described above — drag and children are
  not on the same element as `ct-sheet-enter`.
- `EventRosterSheet` (opened from `EventDetailSheet`) is explicitly deferred
  to Phase 29B2 for its own mobile Escape support, focus trap, and full
  accessibility migration — see §9b. What this checkpoint *does* guarantee
  is `EventDetailSheet`'s side of that interaction: it becomes fully inert
  and hidden from assistive tech while the roster sheet is open on top, and
  correctly regains its own dialog semantics and focus when the roster
  closes — see §9a.
