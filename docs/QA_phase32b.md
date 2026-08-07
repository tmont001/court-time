# Phase 32B — Public Site Access, Features, Positioning, and Pricing — QA

Manual/UI only. No migration required. Test both signed-out (incognito
window or cleared cookies) and signed-in sessions where noted.

---

## 1. Signed-out access to all public routes

As a signed-out visitor, load each of the following directly (not via
in-app navigation) and confirm the page renders — no redirect to `/sign-in`:

- `/`
- `/features`
- `/pricing`
- `/contact`
- `/privacy`
- `/terms`

This is the core regression this checkpoint fixes: before the middleware
change, `/pricing`, `/contact`, `/privacy`, and `/terms` all redirected
signed-out visitors to `/sign-in`.

## 2. Auth protection of authenticated routes

As a signed-out visitor, confirm each of the following still redirects to
`/sign-in`:

- `/calendar`
- `/events`
- `/my-schedule`
- `/admin/members`
- `/profile`
- any other `(app)` route not in the public list

## 3. Signed-in root redirect

As a signed-in Member, Pro, or Admin, load `/` directly and confirm
immediate redirect to `/calendar`. Confirm `/features`, `/pricing`, and
`/contact` still load normally for a signed-in user (they should not
redirect — only `/` redirects when signed in).

## 4. Authentication and invitation routes

As a signed-out visitor, confirm each still loads without redirect:

- `/sign-in`
- `/sign-up`
- `/forgot-password`
- `/reset-password`
- `/welcome`
- `/pending-invite`
- `/join/<a-real-invite-code>`
- `/auth/confirm` (via a real confirmation link if available)

Confirm the invite-code cookie (`ct_invite_pending`) is still set when
opening a `/join/<code>` link, and that it still carries through sign-up to
auto-accept the invite.

## 5. Navigation and CTA links

- Desktop `MarketingNav` (≥ `sm` breakpoint): shows Features, Pricing,
  Request a Pilot, and Sign in. All four resolve.
- Mobile `MarketingNav` (< `sm`): header shows the Court Time wordmark, a
  filled "Request a pilot" button → `/contact`, and a menu (hamburger)
  button. Sign in is reached via the mobile menu, not directly in the
  header. Confirm no crowding or wrapping at 375px width (see §18–19 below
  for the full mobile-menu check).
- `MarketingFooter`: Features, Pricing, Terms, Privacy, Request a Pilot,
  Sign in — all resolve, none point to a placeholder.
- Home hero primary CTA reads "Request a pilot" → `/contact`. Secondary
  reads "Explore features →" → `/features`.
- Home dark-treatment CTA section: both buttons resolve ("Request a pilot"
  → `/contact`, "See pricing →" → `/pricing`).
- Features page hero CTAs: "Request a pilot" → `/contact`, "See pricing" →
  `/pricing`. Closing CTA at the bottom of the page repeats the same two
  links.
- Pricing page CTA: "Request a pilot" → `/contact`.
- Contact page: mailto link opens the user's mail client to
  `hello@court-time.app`; "See what Court Time helps you manage" →
  `/features`; "check the Founding Club pricing" → `/pricing`.

## 6. Home claim accuracy

- Feature grid lists: Court Scheduling, Events/Programs & Waitlists,
  Lessons & Pro Requests, Member Directory & Onboarding, Reporting &
  Oversight, Announcements & Alerts — six cards, no mention of pickleball,
  padel, or other sports.
- "Guided setup, built around your club" section — confirm the old "Up and
  running in a day" wording is gone.
- New "Focused on the workflows tennis clubs use every day." section shows
  three cards (Tennis-focused operations, Guided onboarding, Transparent
  pricing) and does not name a competitor or claim Court Time is the only
  tennis-focused product.
- Dark CTA section references "Founding clubs" and "protected pricing" —
  no dollar figure appears on Home itself (pricing lives on `/pricing`
  only).

## 7. Features page accuracy

Confirm the page now reads as a product tour rather than a flat spec list:

- Hero: "Everything your club needs to stay organized." with Request a
  pilot / See pricing CTAs.
- Five alternating visual-story sections render in order: court
  scheduling, events/programs/waitlists, lessons and Pros, members and
  club operations, reporting and communication — each with a headline, a
  short paragraph, and a product visual.
- A role section ("Built around how your club actually works") shows
  three cards: Admins, Pros, Members.
- A before/after section ("Replace scattered workflows with one clear
  system.") shows a "Before Court Time" list and a "With Court Time" list,
  with no specific time-savings or percentage claims.
- No claim of pickleball/padel/multi-sport support.
- No claim of a native mobile app or device push notifications.
- Reporting story does not claim financial or predictive analytics.

## 8. Founding price accuracy

On `/pricing`, confirm the Founding Club **card** shows exactly:

- $149 / month
- $1,490 / year — two months free
- "Available now — first 10 clubs or until public launch, whichever comes
  first"
- "Protected for your first 12 months"
- "No per-member fee"
- Founder-led setup / Direct founder support
- Fine print: "No credit card required during the founding evaluation and
  onboarding period" and "Billing terms are agreed before any charges
  begin"
- Badge reads "Current offer" (not just a color — it's a visible text
  label on the card and repeated in the comparison table header)
- CTA reads "Request a pilot" and links to `/contact`

## 9. Planned standard price accuracy

Confirm the Starter and Club **cards** show exactly:

- Starter: $249 / month or $2,490 / yr, badge "Planned," "Not currently
  available for purchase"
- Club: $399 / month or $3,990 / yr, badge "Planned," "Not currently
  available for purchase"
- Neither card's CTA says Buy, Subscribe, Start trial, Choose plan, or
  Checkout — both read "Discuss your club" and link to `/contact`
- Intended-scale text ("roughly 5 courts and 100 members" / "roughly 12
  courts and 300 members") is phrased as intended packaging, not as a
  limit the software currently enforces

## 10. Clear distinction between offered and planned pricing

Confirm a visitor can tell, without reading closely, that only Founding
Club is currently offered: the Founding card has a heavier border/shadow
and a solid "Current offer" badge; Starter/Club both say "Planned" and
"Not currently available for purchase." The disclosure block below the
cards states plainly that Starter/Club are planned packages, not final,
and that there is no self-service checkout — without undermining or
hedging the listed prices themselves.

## 11. SMS wording accuracy

Search rendered marketing copy (Home, Features, Pricing, Privacy) for any
SMS mention and confirm:

- No mention of "Twilio" anywhere in marketing UI.
- No claim that SMS is active by default for every club.
- No claim of guaranteed/immediate carrier delivery.
- No claim of bulk SMS marketing.
- Wording stays at the level of "optional text alerts for supported
  transactional updates," with opt-in/opt-out.

## 12. Contact-page temporary email path

- Page title reads "Request a pilot."
- No "scheduling link coming soon" text or placeholder card anywhere on
  the page.
- No reference to a "founding club offer" phrase on this page (pricing
  detail lives on `/pricing`).
- The "Helpful to include" list asks for: club/facility name, court count,
  approximate membership, current booking/event process, main operational
  challenge, preferred contact method.

## 13. Privacy/Terms access and exact changes

- Both pages load signed-out (see #1).
- `/privacy`: "Last updated: August 6, 2026". Data-collected list includes
  lesson-request data and notification preferences (email + optional SMS).
  "Who Can Access Your Data" includes a new Pros bullet. "Email and SMS
  Notifications" section (renamed from "Email Notifications") mentions
  optional SMS and opt-out.
- `/terms`: unchanged — no factual contradictions were found requiring
  edits; "Last updated" date is untouched (still July 7, 2026).

## 14. Mobile

At 375px width, check `/`, `/features`, `/pricing`, `/contact`,
`/privacy`, `/terms`:
- No horizontal overflow/scroll.
- Nav collapses correctly; CTA buttons remain full-width and tappable.
- Pricing card and planned-plans block stack cleanly; text stays legible.

## 15. Dark mode

Toggle dark mode (or set OS preference) and re-check `/`, `/features`,
`/pricing`, `/contact`: no unstyled/white flashes, sufficient contrast on
new copy blocks (planned-plan "(planned)" labels, Features page cards,
Privacy new bullets).

## 16. Reduced motion

With `prefers-reduced-motion: reduce` set, confirm marketing pages (Home,
Features, Pricing) render fully visible immediately — no stuck-invisible
`.mkt-reveal` elements — consistent with existing behavior.

## 17. Authenticated-app smoke regression

Sign in as a Member, a Pro, and an Admin. Confirm:
- Calendar, Events, My Schedule, Profile, and (for Admin) Admin Members /
  Admin Settings all load normally.
- No new redirect loops or auth prompts introduced by the middleware
  change.
- Signing out and reloading any previously-visited `(app)` route redirects
  to `/sign-in` as before.

---

## 18. Mobile CTA reads as a button, not plain nav text

At < `sm` width (375px is a good default), confirm the header's
"Request a pilot" link is visually a filled button (solid background,
padding, rounded corners) — clearly distinct from plain-text navigation —
and sits to the left of the menu (hamburger) button.

## 19. Mobile menu contains every public destination

Tap the menu button and confirm the opened panel lists, in order: Home,
Features, Pricing, Request a Pilot, Sign in. Each link navigates to the
correct route.

## 20. Menu keyboard, Escape, outside-click, and link-close behavior

- The menu button has `aria-label` ("Open menu" / "Close menu"),
  `aria-expanded` (toggles true/false), and `aria-controls` pointing at the
  panel's `id`.
- Open the menu, then press `Tab` — focus moves through the menu links in
  order with a visible focus ring on each.
- With the menu open, press `Escape` — the menu closes and focus returns to
  the menu button.
- With the menu open, click/tap outside the header (e.g. on the page body)
  — the menu closes.
- With the menu open, click any link inside it — the menu closes and
  navigation proceeds.
- Confirm no third-party menu/dropdown library was added (check
  `package.json` — dependencies are unchanged from before this checkpoint).

## 21. Product-tour visuals are faithful to the real application

Open the actual authenticated app side-by-side with `/features` (Calendar,
an event's roster, a lesson request, Admin → Members, Admin → Reports) and
confirm each visual is recognizable as the same product, not a generic
mockup:

- **Court schedule**: fixed time gutter, multiple court columns, hourly
  grid lines with lighter half-hour lines, dashed "available" cells, a
  blue "Your booking"-style reservation block, an event block colored via
  a real event-type color, and a maintenance block using the real diagonal
  hatch pattern — matches `/calendar`'s actual grid, colors, and legend
  ("Your booking").
- **Event/waitlist**: colored event-type pill, the exact capacity phrasing
  ("N of Y spots filled · N on waitlist"), and Waitlisted → Offered →
  Confirmed participant states with the real amber "Spot offered / Accept
  by [time]" treatment — matches `EventDetailSheet`.
- **Lesson**: the same status badge colors/shape as the real lesson UI
  (pending=amber, proposed=blue, confirmed=green), the same `ct-card`
  divide-y detail-row layout (Status/Pro/Duration), and the same
  "time proposed" → "confirmed" progression — matches
  `LessonRequestDetail`/`LessonsClient`.
- **Members**: the real "No account yet" roster-card pill, the real
  "Pending Invites" section heading and invite-row shape, and the real
  "Active" pill — matches `MembersClient`/`RosterCard`, not a generic
  directory table.
- **Reporting**: the real "Key metrics" KPI-tile shape (`ct-card`,
  bold value + tiny label) and the real metric names (Court Utilization,
  Session Fill Rate, Cancellation Rate, Active Members) — matches
  `/admin/reports`. No revenue, savings, benchmarking, or predictive
  figures anywhere.
- No real member, club, or production data appears anywhere — names,
  clubs, and email addresses are all obviously generic placeholders
  (e.g. "Riverside Tennis Club," "j.ortiz@example.com").
- No visual exposes a control that looks clickable but does nothing —
  all product visuals remain purely presentational.
- The mockups are wrapped so a screen reader does not announce their
  content as separate/duplicate information — the surrounding paragraph
  text is what a screen reader user relies on for the substance of each
  story.

## 22. Role-section accuracy

Confirm the three role cards (Admins, Pros, Members) match existing
product behavior only — no new authorization claims:
- Admins: "oversee courts, programs, members, settings, and reporting."
- Pros: "respond to lesson requests and manage permitted
  scheduling/event work."
- Members: "reserve courts, join events, manage waitlists, and request
  lessons."

## 23. Before/after language contains no unsupported metrics

Confirm the before/after section makes no specific time-savings claim, no
percentage claim, no claim that the product eliminates all administrative
work, and does not name a competitor by name.

## 24. Home hero secondary CTA

Confirm the Home hero's secondary action reads "Explore features →" and
links to `/features` (not "Sign in →" — Sign in remains available only via
`MarketingNav`, both desktop and the mobile menu).

## 25. Differentiation section makes no unsupported competitor claim

On Home, confirm "Focused on the workflows tennis clubs use every day."
does not claim Court Time is the only tennis-focused product, does not
claim it is objectively simpler or faster than a named competitor, and
does not promise a specific implementation speed.

## 26. Full responsive sweep

Check `/`, `/features`, `/pricing`, `/contact` at 320px, 375px, 390px,
a tablet width (~768px), and desktop (~1280px):
- No horizontal overflow at any width.
- The Features page's alternating story sections stack cleanly on mobile
  (text above visual) and sit side-by-side from `lg:` up.
- Tap targets (mobile CTA button, menu button, menu links) are comfortably
  sized — no accidental double-hits.

## 27. Dark mode and reduced motion on new content

- Toggle dark mode: mobile menu panel, product visuals (including the
  event-type accent colors, status pill colors, and the maintenance-block
  hatch pattern), role cards, and the before/after cards all render with
  correct contrast, no unstyled flashes.
- With `prefers-reduced-motion: reduce` set, confirm the Features page's
  story sections and the mobile menu open/close are not stuck invisible or
  mid-transition — content is always fully visible. See §29–32 below for
  the product-visual loops specifically.

## 28. Pricing and route behavior unchanged

Re-confirm (this checkpoint should not have touched these): all locked
prices ($149/$1,490, $249/$2,490, $399/$3,990) are unchanged on `/pricing`;
`/pricing`, `/contact`, `/privacy`, `/terms`, `/`, and `/features` are all
still reachable signed-out; authenticated routes still redirect signed-out
visitors to `/sign-in`; "scheduling link coming soon" is still absent from
`/contact`.

---

## 29. Loops progress through only real workflow states

Watch each animated visual through one full ~7–8s cycle and confirm the
states shown, in order, are exactly:
- Court schedule: available cell → brief highlight → reservation appears
  → holds → resets. No fake cursor, the grid cell itself is never
  clickable.
- Event/waitlist: Waitlisted → Offered (with "Accept by" time) →
  Confirmed, with the capacity line updating only at the Confirmed step.
- Lesson: Pending → Proposed (with proposed date/time) → Confirmed (with
  confirmed date/time/court).
- Members: no-account roster card → "Pending Invites" row → Active
  member row. No state implies the invite was accepted automatically —
  the pending-invite state is shown as a distinct, visible step.
- Reporting: KPI tiles reveal → utilization section reveals →
  communication example reveals → holds. The numbers themselves never
  change during the loop, only their appearance.

## 30. Loops pause and reset cleanly

For each visual, confirm there is a genuine hold at the "complete" state
(not an instant flash) before the loop resets, and that the reset is a
smooth fade rather than a jarring cut or layout jump.

## 31. Reduced motion produces one stable, positive end-state

With `prefers-reduced-motion: reduce` set (OS-level or DevTools rendering
emulation), reload `/` and `/features` and confirm every visual shows its
completed state statically, with no cycling:
- Court schedule: the reservation block is present, no highlight.
- Event/waitlist: T. Brooks shows "Confirmed," capacity reads "10 of 12
  spots filled.", no "Spot offered" panel visible.
- Lesson: status badge reads "Confirmed," the green confirmed-time panel
  is visible.
- Members: J. Ortiz shows the "Active" pill; no roster-card or
  pending-invite state is visible.
- Reporting: all three sections (KPI tiles, utilization, communication
  example) are visible simultaneously, no staggering.

## 32. No layout shift from animation

With the browser's layout-shift/rendering tools (or simply watching
closely), confirm none of the five visuals or the Home hero preview cause
surrounding page content to shift, reflow, or resize as their loops run —
every animated element is sized by its static container, only opacity/
background-color/transform change.

---

## 33. Mobile plan rail scrolls horizontally

At 320px/375px/390px, confirm `/pricing`'s plan cards sit in a horizontally
scrollable row (touch-drag or trackpad swipe moves between cards) and that
the page itself never gains horizontal scroll — only the card rail does.

## 34. Cards snap one plan at a time

Swipe slowly and confirm each card comes to rest centered/aligned (CSS
scroll-snap), not stopping at an arbitrary mid-card position. Each card
shows roughly 85–90% of the viewport width, with the edge of the next card
visible as an affordance.

## 35. No automatic movement occurs

Load `/pricing` and wait at least 15 seconds without touching anything —
confirm the plan rail never advances, rotates, or loops on its own.

## 36. Previous/Next buttons work and disable appropriately

- On the first plan (Founding Club), the Previous button (‹) is disabled.
- On the last plan (Club), the Next button (›) is disabled.
- Clicking Next/Previous moves exactly one card and updates the "N of 3"
  text and the dot indicator.
- Both buttons have visible focus rings and are reachable/operable via
  keyboard (Tab + Enter/Space).

## 37. Card indicator updates after swipe and button movement

Swipe manually to the second and third cards (no buttons) and confirm the
"N of 3" text and dots update to match, not just when using the
Previous/Next buttons.

## 38. Founding Club is clearly the current offer

On both the card and the comparison table, Founding Club is visually
distinguished by more than color alone: a heavier border/shadow plus the
explicit text label "Current offer" on the card, and a bold header +
"Current offer" text + a two-sided border in the table.

## 39. Starter and Club are clearly planned

Both cards and both comparison-table headers say "Planned"; both cards say
"Not currently available for purchase"; neither card's CTA uses purchase
language (confirmed absent: Buy, Subscribe, Start trial, Choose plan,
Checkout).

## 40. All locked prices remain exact

$149, $1,490, $249, $2,490, $399, $3,990 all appear unchanged, in both the
cards and every relevant comparison-table row.

## 41. Desktop shows all three cards simultaneously

At `lg:` width and above, all three plan cards render in a static 3-column
grid with no horizontal scrolling and no Previous/Next/indicator controls
visible (they're `lg:hidden`). Card heights are visually balanced across
the row.

## 42. Compare-all-features link reaches the comparison section

Click "Compare all features" (appears twice: the link above the disclosure
and the `<h2>` above the table) and confirm the page scrolls to the
comparison table via the `#compare` anchor. Tab-navigate to confirm the
target section is reachable and receives focus (no visible focus outline
is acceptable here since the section itself isn't meant to show a ring,
but keyboard focus should land there per its `tabIndex={-1}`).

## 43. Semantic table structure

Inspect the comparison table's markup (or an accessibility tree tool) and
confirm: one real `<table>` with `<caption>` (visually hidden), `<thead>`
with `scope="col"` headers, `<tbody>` rows using `scope="row"` for the
Feature column, and `scope="colgroup"` section-divider rows ("Pricing and
availability," "Product," "Service") — not a div-grid pretending to be a
table.

## 44. Checkmarks have accessible Included text

For every Product-section row, confirm the checkmark glyph is
`aria-hidden="true"` and is accompanied by visually-hidden ("Included")
text that a screen reader announces.

## 45. Core features show included across all three plans

All ten Product-section rows (court scheduling through responsive web
access) show a checkmark in all three columns — Founding, Starter, and
Club — with no row showing a gap or an X for any plan.

## 46. Intended scale/onboarding/support differences are accurate

Confirm the only differences between plans in the table are: price,
availability, intended scale, onboarding level, support level, and price
protection — never the Product-section feature rows.

## 47. Planned limits are not described as current software enforcement

Confirm "roughly 5 courts and 100 members" / "roughly 12 courts and 300
members" are phrased as intended packaging (both the card body text and
the table's "Intended scale" row), never as a limit the product currently
enforces.

## 48. Mobile table scrolling and optional sticky first column

At 320px–390px, confirm the comparison table scrolls horizontally within
its own bordered container (not the page), the "Swipe to compare plans →"
hint is visible above it, and the Feature column stays pinned on the left
as the table scrolls, remaining legible with no visual overlap/tearing
against the scrolling columns.

## 49. No page-level horizontal overflow

Across the whole `/pricing` page (header, cards, disclosure, table, FAQ),
confirm the page's own horizontal scrollbar never appears at any tested
width — only the two intentional inner-scroll containers (card rail,
table) scroll.

## 50. Keyboard and focus behavior

Tab through `/pricing` from the top: header → card rail (focusable via
`tabIndex={0}` on the region, arrow/Page keys scroll it) → Previous/Next
buttons → each card's CTA link → "Compare all features" link → comparison
table region (`tabIndex={0}`, scrollable via keyboard) → FAQ items. No
keyboard trap; every interactive element shows a visible focus ring.

## 51. Dark mode and reduced motion

- Dark mode: cards, badges, table (including the sticky column and section
  rows), and the disclosure block all render with correct contrast, no
  unstyled flashes.
- With `prefers-reduced-motion: reduce` set, confirm Previous/Next button
  clicks jump instantly (no smooth scroll animation) while native
  swipe/drag scrolling still works normally.

## 52. No purchase/checkout language anywhere on the page

Grep/scan the full rendered `/pricing` page for "Buy," "Subscribe," "Start
trial," "Choose plan," or "Checkout" as CTA or button text — none should
appear (the disclosure's use of the word "checkout" in "no self-service
checkout" is the only expected occurrence, and it's explicitly a negation).

## 53. Existing Phase 32B QA remains valid

Spot-check that this pass did not regress: public-route access (§1–4),
mobile navigation (§18–20), Home and Features content (§6–7), product
visuals and their animations (§21, §29–32), Privacy/Terms (§13), and the
authenticated-app smoke regression (§17) — none of these were touched in
this checkpoint.
