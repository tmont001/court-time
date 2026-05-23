# Phase 15 Plan: Mobile & Admin UX Polish

_Status: PLANNING — no code written yet_
_Preceded by: Phase 14 (Admin Role & Access Management + Settings Cleanup — all complete)_

---

## 1. Recommended Scope

Phase 15 is a pure UX and polish phase. No new database migrations. No new RPCs. No new server actions. All changes are frontend-only.

### 15A — Mobile Shell Polish
Fix four categories of mobile presentation issues present in the current shell:
1. **Sticky header** — `Header` is currently a static block element; it scrolls away with page content on long pages (Members, Events, Profile, Settings).
2. **Safe-area insets** — iOS home indicator overlaps the BottomNav on iPhone X+; no `viewport-fit=cover` meta tag is set.
3. **Gray gutters / horizontal overflow** — the root layout caps content at `max-w-[430px]` but fixed elements (`BottomNav`, bottom sheets) use `left-0 right-0` and escape the cap. On screens 430–640 px wide, the nav spans the full viewport while content is narrower, leaving gray gutters. The calendar grid can also trigger horizontal overflow on narrow screens.
4. **Verify calendar usability** — confirm that date pill strip, court filter chips, grid scroll, slot tap, and all sheets remain fully functional on a 390 px viewport after the shell changes.

### 15B — Admin Members Sorting
Add client-side sort controls to the Admin Members page. The list currently renders in DB insertion order. Sort by: first name, last name, role, status. All Phase 14 role/status controls (role dropdown, Deactivate/Reactivate, last-admin guard) must continue working after a sort change. Pending Invites section is unaffected.

### 15C — BottomSheet Component + Cautious Migration
Extract the repeated bottom-sheet pattern into a reusable `BottomSheet` component. Migrate only simple, statically-scoped sheets first. Drag-to-dismiss is included but scoped to the drag handle only (never competes with internal scroll areas). Complex sheets with internal forms or scroll are explicitly excluded from migration.

### 15D — QA / Regression Pass
Produce and execute `supabase/scripts/QA_phase15d.md`. 30+ checks covering shell, sort, sheet component, dark mode, all themes, multi-role matrix, and build.

---

## 2. Explicitly Deferred (not in scope for Phase 15)

- Notifications & Communications (was original Phase 14 intent — intentionally deferred past Phase 15)
- Event/guest registration implementation
- Public embeds
- Self-serve club signup
- Operator setup UI (`/operator/setup-club`)
- Multi-club switching
- `operating_hours_override` enforcement in `create_reservation`
- Automated suspension / billing
- Bulk role/status actions
- Email/SMS notification on role or status change

---

## 3. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Sticky header breaks `calc(100dvh - 56px - 64px)` in CalendarShell | Low | Header is in the document flow (sticky, not fixed); it still occupies 56 px, so the subtraction stays correct. Verify after change. |
| Removing `max-w-[430px]` root cap breaks desktop layout | Low–Medium | Individual admin pages already use `md:max-w-3xl md:mx-auto`. Calendar fills width via ResizeObserver. Check Events and Profile pages. |
| Safe-area insets shrink available booking-grid height | Low | The `56px` header and `64px` nav heights are hard-coded; safe-area changes only affect nav padding, not grid height calc. Confirm visually. |
| `z-index` conflict between sticky header and calendar sticky court-name row | Low | Header `z-30`, calendar court-name row `z-20`, sheets `z-40/50` — stacking order is clean. |
| Drag-to-dismiss gesture competing with internal scroll in migrated sheets | Mitigated by design | Only attach drag handling to the drag handle element. Content area scroll is untouched. |
| `BottomSheet` migration introduces regressions in complex sheets | Mitigated by design | `CreateEventSheet`, `CreateMaintenanceSheet`, `EventDetailSheet`, and CalendarShell inline sheets are explicitly excluded from migration. |
| Member sort breaks role/status controls (stale state by index) | Low | Sort operates on the `members` prop array by value (id-keyed state maps); row identity is by `m.id`, not array index. |

---

## 4. Checkpoint Breakdown

### Checkpoint 15A: Mobile Shell Polish

**Goal:** Header always visible. No horizontal scroll. No unsafe-area overlap. Calendar unaffected.

**Changes:**

1. `src/app/layout.tsx`
   - Remove `max-w-[430px]` from the wrapper div — content becomes full-width everywhere. (Individual pages with `md:max-w-3xl md:mx-auto` already cap themselves for wide screens.)
   - Add `overflow-x-hidden` to the wrapper div to suppress horizontal overflow from the calendar grid on narrow screens.
   - Export a `viewport` config object to set `viewport-fit=cover` (Next.js 13 App Router pattern).

2. `src/components/Header.tsx`
   - Add `sticky top-0 z-30` to the `<header>` element.
   - No other changes — it stays a server component, continues to fetch club name and logo.

3. `src/components/BottomNav.tsx`
   - Add `pb-[env(safe-area-inset-bottom)]` (or equivalent) to the nav element so it clears the iOS home indicator.
   - Adjust the content offset: `h-16` → the nav height grows dynamically with safe-area padding; the hardcoded `pb-16` in AppLayout should become `pb-[calc(4rem+env(safe-area-inset-bottom))]` OR we rely on the fixed nav's own padding making content visible above it (since the nav is `fixed`, the `pb-16` on main exists only to prevent overlap — we can set it slightly larger or use a CSS variable).

4. `src/app/(app)/layout.tsx`
   - Adjust `pb-16` on `<main>` to `pb-20` or `pb-[calc(4rem+env(safe-area-inset-bottom))]` to maintain clearance above the safe-area-padded BottomNav.

5. **Verification only** (no code change expected): run `pnpm build`, then verify CalendarShell's `height: calc(100dvh - 56px - 64px)` still works correctly by testing on a phone viewport. The `56px` header and `64px` nav hardcodes are still accurate after the sticky change.

---

### Checkpoint 15B: Admin Members Sorting

**Goal:** Members list is sortable. Existing controls unaffected.

**Changes:**

1. `src/app/(app)/admin/members/MembersClient.tsx`
   - Add `sortBy` state: `"first_name" | "last_name" | "role" | "status"`, default `"first_name"`.
   - Add `sortedMembers` memo: `useMemo` over `members` sorted by the current field.
     - `first_name` / `last_name`: alphabetical, `null` sorts last.
     - `role`: alphabetical (`admin` → `member` → `pro`... or a defined order: admin, pro, member).
     - `status`: active before inactive (or alphabetical).
   - Add sort control UI: a compact row of labeled chips or a single `<select>` above the member list, inline with the "Members" label and "+ Invite" button row. Chips are preferred (consistent with the rest of the app).
   - All existing role dropdown, status badge, Deactivate/Reactivate, last-admin guard, and error display remain unchanged — they operate by `m.id`, not by array index.

**No changes to:**
- `page.tsx` (server component, unchanged)
- `actions.ts` (no new server actions)
- `InviteSheet.tsx`
- Pending Invites section

---

### Checkpoint 15C: BottomSheet Component + Cautious Migration

**Goal:** Reusable `BottomSheet` component exists. Two simple sheets migrated. Complex sheets untouched.

**Step 1: Create `src/components/BottomSheet.tsx`**

Props:
```ts
interface BottomSheetProps {
  onClose: () => void;
  children: React.ReactNode;
  // Optional: passed to the sheet panel for padding override
  className?: string;
}
```

Structure:
- Backdrop: `fixed inset-0 bg-black/30 z-40` — click calls `onClose`.
- Sheet panel: `fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 rounded-t-2xl z-50 shadow-xl`.
- Drag handle: `w-10 h-1 bg-gray-200 dark:bg-gray-600 rounded-full mx-auto mt-3 mb-1 cursor-grab` — drag handling attached here.
- Content area: `children` rendered below the handle.

Drag-to-dismiss logic:
- State: `dragY: number` (0 = resting), `isDragging: boolean`.
- `onPointerDown` on the handle element: capture pointer, record start Y, set `isDragging = true`.
- `onPointerMove` on the handle: compute delta Y from start; if delta > 0, apply `translateY(deltaY)` to the sheet panel. No transform if dragging upward.
- `onPointerUp` / `onPointerCancel` on the handle: if final delta > 100 px, call `onClose`; otherwise snap back to 0 with a 200 ms ease transition.
- CSS transition on the sheet: `transition-transform duration-200` — disabled during active drag (set via a CSS class toggle).
- The content area (`children`) has no pointer event override — scrollable children scroll normally. Only the drag handle initiates the dismiss gesture.

**Step 2: Migrate `ReservationDetailSheet.tsx`**
- Replace the two outermost divs (backdrop + sheet panel) with `<BottomSheet onClose={onClose}>`.
- Preserve all existing content exactly (reservation details, cancel button, confirmation dialog, error states).
- Behavioral parity: tap backdrop → close, drag handle down → close, confirm cancel flow unchanged.

**Step 3: Migrate `NotificationSheet.tsx`**
- Replace the two outermost divs with `<BottomSheet onClose={onClose}>`.
- Preserve scrollable notification list and all content.

**Explicitly excluded from migration:**
- `InviteSheet.tsx` — **intentionally deferred**, not forgotten. Candidate for a later polish checkpoint once the first two migrations are confirmed stable.
- `CreateEventSheet.tsx` — complex form, date picker, internal `overflow-y-auto` scroll area.
- `CreateMaintenanceSheet.tsx` — similar complexity.
- `EventDetailSheet.tsx` — has nested `EventRosterSheet` and internal scroll.
- CalendarShell inline sheets (slot action menu and booking sheet) — tightly coupled to CalendarShell state; migration would require significant refactoring with no user-visible benefit.

---

### Checkpoint 15D: QA / Regression Pass

Produce `supabase/scripts/QA_phase15d.md` and execute all checks.

Categories:
- Mobile shell (sticky header, BottomNav, horizontal overflow, safe-area)
- Calendar (date navigation, court filter, booking, all sheets, admin FAB)
- Admin Members (sort controls, role/status controls, last-admin guard, invites)
- BottomSheet component (migrated sheets: ReservationDetailSheet, NotificationSheet)
- Non-migrated sheets regression (CreateEventSheet, CreateMaintenanceSheet, EventDetailSheet)
- Admin Settings (Operating Hours, Branding, Booking Rules)
- Dark mode
- All 5 themes (classic-gray, forest-green, clay-court, ocean-blue, royal-purple)
- Multi-role matrix (member, pro, admin) on Calendar
- Build: `pnpm build` clean

---

## 5. Likely Files to Change

### New files
| File | Checkpoint | Purpose |
|---|---|---|
| `src/components/BottomSheet.tsx` | 15C | Reusable bottom-sheet wrapper |
| `supabase/scripts/QA_phase15d.md` | 15D | QA checklist |

### Modified files
| File | Checkpoint | Change |
|---|---|---|
| `src/app/layout.tsx` | 15A | Remove `max-w-[430px]`, add `overflow-x-hidden`, export `viewport` with `viewport-fit=cover` |
| `src/components/Header.tsx` | 15A | Add `sticky top-0 z-30` |
| `src/components/BottomNav.tsx` | 15A | Add safe-area-inset-bottom padding |
| `src/app/(app)/layout.tsx` | 15A | Adjust `pb-16` on `<main>` for safe-area compatibility |
| `src/app/(app)/admin/members/MembersClient.tsx` | 15B | Add sort state, sort memo, sort controls |
| `src/app/(app)/calendar/ReservationDetailSheet.tsx` | 15C | Migrate to `<BottomSheet>` |
| `src/components/NotificationSheet.tsx` | 15C | Migrate to `<BottomSheet>` |

### Not changed (confirmed out of scope)
- All `supabase/migrations/` files — no DB changes
- `actions.ts` files — no new server actions
- `CalendarShell.tsx` (beyond verification)
- `CreateEventSheet.tsx`, `CreateMaintenanceSheet.tsx`, `EventDetailSheet.tsx`, `EventRosterSheet.tsx`
- `InviteSheet.tsx`

---

## 6. Acceptance Criteria

### 15A
1. Scrolling any long page (Members, Events, Profile, Settings) keeps the Header visible at the top at all times.
2. No horizontal scrollbar appears on any page at 390 px viewport width.
3. The BottomNav does not obscure content on iPhone X+ (safe-area-inset-bottom respected).
4. The calendar renders correctly and all interactions work at 390 px: date pill navigation, court filter chips, slot tap, booking sheet, event sheet.
5. `pnpm build` passes with no TypeScript errors.

### 15B
1. Sort controls are visible above the Members list.
2. Sorting by each option (first name, last name, role, status) correctly reorders the list.
3. After sorting, the role dropdown on each card still saves role changes.
4. After sorting, the Deactivate/Reactivate button on each card still works.
5. The last-admin guard ("Last admin — cannot change.") still appears on the correct card regardless of sort order.
6. Pending Invites section is unaffected.
7. `pnpm build` passes.

### 15C
1. `src/components/BottomSheet.tsx` exists and exports a `BottomSheet` component.
2. Tapping the backdrop closes the sheet.
3. Dragging the handle down more than ~100 px dismisses the sheet.
4. Dragging up or less than ~100 px snaps the sheet back to resting position.
5. `ReservationDetailSheet` behaves identically to before migration (open, cancel flow, error state).
6. `NotificationSheet` behaves identically to before migration (open, scrollable list).
7. `CreateEventSheet`, `CreateMaintenanceSheet`, and CalendarShell inline sheets are unchanged.
8. `pnpm build` passes.

### 15D
1. All 30+ QA checklist items are completed and marked pass.
2. No regressions found in any Phase 14 feature (role management, status management, Operating Hours editor).
3. `pnpm build` passes clean.

---

## 7. Test Plan

All QA is performed against the **deployed Vercel app** (primary) and optionally `pnpm dev` locally (now stable after path fix). No automated test suite exists; all testing is manual.

### 15A Test Scenarios
| Scenario | Steps | Expected |
|---|---|---|
| Header stickiness | Open Admin Members; scroll list down past the fold | Header stays at top |
| Header stickiness | Open Events page; scroll down | Header stays at top |
| Calendar unaffected | Open Calendar; tap slot, open booking sheet | Sheet appears; header visible above |
| No horizontal scroll | Open Calendar with 3 courts on 390 px viewport; filter to 1 court | No horizontal scrollbar |
| Safe-area (iOS) | View BottomNav on iPhone 14 | Nav content above home indicator |
| Gray gutters | View any page on 500 px viewport | No visible gutters between content and screen edge |

### 15B Test Scenarios
| Scenario | Steps | Expected |
|---|---|---|
| Sort first name | Click "First Name" sort chip | Members reorder A→Z by first name |
| Sort role | Click "Role" sort chip | Admins grouped, then Pros, then Members (or alpha) |
| Sort status | Click "Status" sort chip | Active members before inactive |
| Role change after sort | Sort by last name; change a member's role | Role saves; router.refresh updates list |
| Status change after sort | Sort by role; deactivate a member | Confirmation dialog appears; status saves; card dims |
| Last-admin guard after sort | Sort so last admin is not first | "Last admin — cannot change." still shows on that card |

### 15C Test Scenarios
| Scenario | Steps | Expected |
|---|---|---|
| Backdrop dismiss | Open ReservationDetailSheet; tap gray backdrop | Sheet closes |
| Drag dismiss | Open ReservationDetailSheet; drag handle down > 100 px | Sheet dismisses with slide animation |
| Snap back | Open ReservationDetailSheet; drag handle down < 50 px, release | Sheet snaps back |
| ReservationDetailSheet cancel | Open sheet; tap "Cancel Reservation" | Confirmation dialog appears; cancellation works |
| NotificationSheet opens | Tap bell icon; sheet opens | Notification list visible |
| NotificationSheet drag dismiss | Drag notification sheet handle down | Sheet dismisses |
| CreateEventSheet unchanged | Pro/admin tap + Event | Full form sheet opens, works as before |
| CalendarShell booking sheet | Tap empty slot; booking sheet opens | Still works; no BottomSheet component involved |

### 15D
Execute QA_phase15d.md checklist in full.

---

## 8. Build / Implementation Prompts

These are the prompts to use when implementing each checkpoint (one at a time, in order).

---

### Prompt 15A

```
Implement Phase 15A: Mobile Shell Polish.

Context:
- This is a Next.js 14 App Router project using Tailwind CSS.
- Primary codebase path: ~/projects/court-time
- Phase 14 is complete. No DB changes in Phase 15.

Changes to make:

1. src/app/layout.tsx
   - Add a `viewport` export (Next.js App Router pattern) that includes
     `width: "device-width"`, `initialScale: 1`, and `viewportFit: "cover"`.
   - On the wrapper <div>: remove `max-w-[430px]` (the content is now full-width
     at all breakpoints; individual pages handle their own max-widths).
     Keep `w-full min-h-screen bg-white dark:bg-gray-900`. Add `overflow-x-hidden`.

2. src/components/Header.tsx
   - Add `sticky top-0 z-30` to the outer <header> element.
   - No other changes. Keep it a server component.

3. src/components/BottomNav.tsx
   - Add `pb-[env(safe-area-inset-bottom)]` to the <nav> element to prevent
     content from being hidden behind the iOS home indicator.

4. src/app/(app)/layout.tsx
   - Change `pb-16` on <main> to `pb-20` to ensure content clears the
     safe-area-padded BottomNav on iOS.

Guard rails:
- Do NOT convert Header to a client component.
- Do NOT modify CalendarShell.tsx — its `height: calc(100dvh - 56px - 64px)` 
  remains correct because the sticky Header still occupies 56px in the flow.
- z-index order must be preserved: calendar court-name header (z-20) < 
  sticky app Header (z-30) < BottomNav and sheet overlays (z-40) < sheet panels (z-50).
- pnpm build must pass with no TypeScript errors.
```

---

### Prompt 15B

```
Implement Phase 15B: Admin Members Sorting.

Context:
- File to change: src/app/(app)/admin/members/MembersClient.tsx only.
- Do NOT modify page.tsx, actions.ts, or InviteSheet.tsx.
- Phase 14 role/status controls must continue to work after sorting.

Changes to make:

1. Add sort state:
   type SortBy = "first_name" | "last_name" | "role" | "status";
   const [sortBy, setSortBy] = useState<SortBy>("first_name");

2. Add sortedMembers memo (useMemo over the members prop):
   - first_name / last_name: case-insensitive alphabetical; null sorts last.
   - role: defined order — admin first, then pro, then member.
   - status: active before inactive.
   - Original members prop is NOT mutated.

3. Render sortedMembers instead of members in the list.

4. Add sort control UI:
   - Insert a compact row of small chips (same style as court filter chips 
     in CalendarShell: px-3 py-1 rounded-full text-xs font-medium, accent 
     color when active) in the header row above the member cards.
   - Labels: "A–Z Name" | "Last Name" | "Role" | "Status"
   - Active chip: bg-accent text-white. Inactive: bg-gray-100 text-gray-600.
   - Place the chip row between the "Members" label / "+ Invite" button row 
     and the member card list.

Guard rails:
- All m.id-keyed state (changingRoleId, roleErrors, statusChangingId, 
  confirmDialog) is already keyed by member ID, not array index — 
  sort will not break them.
- activeAdminCount is derived from the full members prop (not sortedMembers), 
  which is correct — it should count all active admins regardless of sort.
- pnpm build must pass.
```

---

### Prompt 15C

```
Implement Phase 15C: BottomSheet component and cautious migration.

Context:
- Phase 15A and 15B are complete.
- Do NOT migrate CreateEventSheet, CreateMaintenanceSheet, EventDetailSheet,
  EventRosterSheet, InviteSheet, or CalendarShell inline sheets.

Step 1: Create src/components/BottomSheet.tsx

Props interface:
  interface BottomSheetProps {
    onClose: () => void;
    children: React.ReactNode;
    className?: string;  // applied to the sheet panel div, for padding overrides
  }

Implementation:
- "use client"
- Backdrop: fixed inset-0 bg-black/30 z-40; onClick calls onClose.
  Prevent propagation from sheet panel to backdrop.
- Sheet panel: fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 
  rounded-t-2xl z-50 shadow-xl; apply dragY translateY transform.
- Drag handle: w-10 h-1 bg-gray-200 dark:bg-gray-600 rounded-full mx-auto 
  mt-3 mb-1 cursor-grab shrink-0.
- Drag-to-dismiss logic (on the drag handle div only):
  - onPointerDown: setPointerCapture, record startY, set isDragging=true.
  - onPointerMove: delta = e.clientY - startY; if delta > 0, set dragY=delta.
  - onPointerUp / onPointerCancel: releasePointerCapture; if dragY > 100, 
    call onClose; else set dragY=0 (snaps back). Set isDragging=false.
  - Sheet panel CSS transition: transition-transform duration-200 ease-out 
    when NOT dragging; no transition during active drag.
- Content area: children rendered below the handle in a div.
  No pointer-event overrides — internal scroll areas work normally.

Step 2: Migrate src/app/(app)/calendar/ReservationDetailSheet.tsx
- Replace the two outer divs (backdrop + sheet panel) with <BottomSheet onClose={onClose}>.
- Preserve all existing content, state, and logic exactly.
- The existing confirmation dialog (fixed inset-0 / z-50 centered modal) stays 
  as-is inside children — it will stack above the sheet correctly.

Step 3: Migrate src/components/NotificationSheet.tsx
- Replace the two outer divs with <BottomSheet onClose={onClose}>.
- Preserve all existing content exactly.

Guard rails:
- The existing drag handle markup already present inside some sheets 
  (w-10 h-1 rounded-full) should be REMOVED from those sheets after 
  migration — BottomSheet renders its own.
- pnpm build must pass with no TypeScript errors.
```

---

### Prompt 15D

```
Create Phase 15D QA checklist: supabase/scripts/QA_phase15d.md

The checklist must cover:

1. Mobile Shell (15A)
   - Header sticky on: Calendar, Events, My Schedule, Profile, Admin Members,
     Admin Settings, Admin Audit Log
   - No horizontal scroll on: Calendar (1 court, 3 courts), Events, Members
   - BottomNav: no content obscured by home indicator on iOS
   - Page backgrounds: no visible gray gutters on any viewport width

2. Calendar (regression)
   - Date pill navigation
   - Court filter chips
   - Member: tap slot → booking sheet → confirm booking
   - Pro/Admin: tap slot → action menu → book / create event / maintenance block
   - Event block tap → EventDetailSheet opens and closes
   - Reservation block tap (admin) → ReservationDetailSheet opens and closes
   - Admin cancel reservation via ReservationDetailSheet
   - Closed day banner
   - Operating hours respected (no slots outside open hours)

3. Admin Members (15B + Phase 14 regression)
   - Sort by first name, last name, role, status each reorders correctly
   - Role change after sort (pick a non-default sort; change a role; confirm save)
   - Deactivate after sort (confirm dialog; confirm deactivation)
   - Reactivate after sort
   - Last-admin guard: correct card is protected regardless of sort order
   - Self row: controls disabled on own card
   - Invite flow unaffected by sort state

4. BottomSheet (15C)
   - ReservationDetailSheet: tap backdrop closes
   - ReservationDetailSheet: drag handle > 100 px dismisses
   - ReservationDetailSheet: drag handle < 50 px snaps back
   - ReservationDetailSheet: cancel reservation flow works
   - NotificationSheet: tap backdrop closes
   - NotificationSheet: drag handle dismisses
   - NotificationSheet: scroll inside sheet works without triggering dismiss
   - CreateEventSheet: opens and functions correctly (not migrated; no regression)
   - CreateMaintenanceSheet: opens and functions correctly (not migrated)
   - EventDetailSheet: opens and functions correctly (not migrated)

5. Dark mode
   - Shell header and BottomNav correct in dark mode
   - All 5 themes in dark mode: classic-gray, forest-green, clay-court, ocean-blue, royal-purple
   - BottomSheet component dark mode correct (bg-gray-800 panel, correct handle color)

6. Multi-role matrix on Calendar
   - Member: booking only; no FAB; no action menu
   - Pro: FAB (+Event); action menu shows Book/Create Event; no Maintenance Block
   - Admin: FAB (+Block, +Event); action menu shows all three options

7. Admin Settings regression
   - Operating Hours editor: edit, save, conflict detection
   - Booking Rules form
   - Club Branding section

8. Build
   - pnpm build passes with zero TypeScript errors and zero warnings

Mark each item [ ] Not tested, [x] Pass, or [!] Fail with notes.
```

---

## Notes for Implementation

- **No migrations needed.** Phase 15 is entirely frontend. The DB schema, RPCs, and RLS policies from Phases 1–14 are unchanged.
- **Implement checkpoints in order** (15A → 15B → 15C → 15D). Each checkpoint's acceptance criteria must be verified before starting the next.
- **One commit per checkpoint** is the target. If a checkpoint has a natural split (e.g., 15C Step 1 separate from Steps 2–3), a second commit within the checkpoint is fine.
- **`pnpm build` must pass** at the end of every checkpoint before committing.
- **QA target:** primary is Vercel deployment + Supabase SQL Editor. Local `pnpm dev` is also available (stable after path fix).
