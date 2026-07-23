# Phase 24 QA Checklist

Covers Phase 24A (Member CRM Foundation), Phase 24B (Admin Lesson Operations),
Phase 24C (Navigation, Responsive Overlay, Admin Proposal), and
Phase 24D (Member Bookings Consolidation, Lesson-Action UX).
Migrations 0075–0078. Apply migrations before testing.

---

## Phase 24A — Member CRM Foundation

### 24A-1: Member Notes — Add

- [ ] Sign in as admin
- [ ] Open admin/members, click a member → View
- [ ] On Notes tab, click "Add Note"
- [ ] Type a note and submit → note appears at top of list with author name and timestamp
- [ ] Note content up to 1000 chars accepted; 1001+ shows error

### 24A-2: Member Notes — Edit

- [ ] On Notes tab, click Edit on an existing note
- [ ] Change content → note updates in place without page refresh
- [ ] Empty content on edit shows error "content_required"

### 24A-3: Member Notes — Archive

- [ ] Click Archive on a note
- [ ] Note disappears from list (soft-deleted; not shown in get_member_notes)

### 24A-4: Member Notes — Non-admin blocked

- [ ] Sign in as a member
- [ ] Call add_member_note via supabase.rpc → should return error "insufficient_role"

### 24A-5: get_admin_member_detail — Stats

- [ ] Sign in as admin
- [ ] Open /admin/members/{id} for a member who has attended events and had lessons
- [ ] Verify attended_event_count, event_no_show_count, completed_lesson_count,
      member_lesson_no_show_count render correctly in the member detail header

### 24A-6: get_members — No admin_notes in response

- [ ] Sign in as admin
- [ ] Call supabase.rpc("get_members") → verify response rows do NOT contain admin_notes field
- [ ] The MembersClient member list renders without admin notes editor (names are clickable links)

### 24A-7: Member Detail Page — Upcoming tab

- [ ] Open /admin/members/{id} for a member with upcoming events/lessons/reservations
- [ ] Upcoming tab shows all three activity types
- [ ] Event rows show title, start time
- [ ] Lesson rows show pro name, duration, status, proposed time if set
- [ ] Reservation rows show court name, start/end time

### 24A-8: Member Detail Page — History tab

- [ ] History tab shows past events (confirmed participant status) and terminal lessons
- [ ] Waitlisted/offered event participants do NOT appear
- [ ] Event rows show attendance controls (attended / no-show) for status='confirmed'
- [ ] Lesson rows show outcome controls for status='confirmed'
- [ ] Marking attendance updates the row without page refresh
- [ ] Load More button fetches the next page using composite cursor

### 24A-9: Member Detail Page — 404 for unknown member

- [ ] Navigate to /admin/members/<random-uuid> → should show Next.js 404

### 24A-10: profiles privacy — admin_notes column blocked from members

- [ ] Sign in as a member (non-admin)
- [ ] Attempt: supabase.from("profiles").select("admin_notes").eq("id", <other_user>).single()
- [ ] Should return null for admin_notes (column not in GRANT list for authenticated)

---

## Phase 24B — Admin Lesson Operations

### 24B-1: Reassign Provider — pending request

- [ ] Sign in as admin, open /admin/lessons
- [ ] Select a pending lesson request, click "Reassign Provider"
- [ ] Pick a different pro → confirm reassign
- [ ] Request now shows new pro; status remains 'pending'
- [ ] New pro receives lesson_request_received notification
- [ ] Member receives lesson_provider_reassigned notification

### 24B-2: Reassign Provider — proposed request resets to pending

- [ ] Select a proposed lesson request
- [ ] Click "Reassign Provider", pick a different pro
- [ ] Request resets to pending; proposed time/court cleared
- [ ] Old pro receives lesson_provider_reassigned notification (same as pending case)
- [ ] New pro receives lesson_request_received notification
- [ ] Member receives lesson_provider_reassigned notification

### 24B-3: Reassign Provider — same pro rejected

- [ ] Try to reassign a request to the same pro already assigned
- [ ] Should show error (same_pro)

### 24B-4: Reassign Provider — non-pending/proposed rejected

- [ ] Try to reassign a confirmed or declined lesson
- [ ] Should show error (invalid_status_for_reassign)

### 24B-5: Reassign Provider — non-admin blocked

- [ ] Sign in as pro or member
- [ ] Call reassign_lesson_provider RPC directly → should return error "insufficient_role"

### 24B-6: Admin Create Lesson Request — success

- [ ] Sign in as admin, open /admin/lessons
- [ ] Click "Create Lesson Request"
- [ ] Select a member, a pro, duration (30/45/60/90), optional note
- [ ] Submit → new request appears in list with status 'pending' and last_actor_role='admin'
- [ ] Pro receives lesson_request_received notification
- [ ] Member receives lesson_admin_requested notification

### 24B-7: Admin Create Lesson Request — inactive member rejected

- [ ] Create request with an inactive member selected
- [ ] Should show error (account_inactive)

### 24B-8: Admin Create Lesson Request — non-pro pro_id rejected

- [ ] Try to create with a member or admin as the pro
- [ ] Should show error (pro_not_found)

### 24B-9: Admin Create Lesson Request — member and pro cannot be the same

- [ ] Try to set member_id == pro_id (e.g., for a pro who is also a member)
- [ ] Should show error (cannot_request_yourself)

### 24B-10: get_club_pros — all authenticated users

- [ ] Sign in as admin → supabase.rpc("get_club_pros") returns active lesson providers
      with fields: id, first_name, last_name, role, is_lesson_provider
- [ ] Sign in as member → returns the same list (grant is to authenticated, not admin-only)
      (members need this to populate the RequestLessonSheet pro picker on /my-schedule)

### 24B-11: Member Detail — Upcoming tab shows active lessons

- [ ] After admin creates a request for a member, open that member's detail page
- [ ] The new pending lesson request appears in the Upcoming tab

### 24B-12: MembersClient View link

- [ ] Open /admin/members
- [ ] Each member card shows a "View" link button
- [ ] Clicking View navigates to /admin/members/{id}
- [ ] Member name in card header is also clickable and navigates to detail page

### 24B-13: Pro view — no create button

- [ ] Sign in as pro, open /admin/lessons
- [ ] Should not see "Create Lesson Request" button (admin-only feature)

### 24B-14: Reassign button visibility

- [ ] Admin view, pending request → "Reassign Provider" button visible
- [ ] Admin view, proposed request → "Reassign Provider" button visible
- [ ] Admin view, confirmed request → "Reassign Provider" button NOT visible
- [ ] Pro view → "Reassign Provider" button NOT visible
- [ ] No pros in club → button NOT visible

---

## Phase 24C — Navigation, Responsive Overlay, Admin Proposal

### 24C-1: Desktop sidebar — admin view

- [ ] Sign in as admin on a desktop (≥ 768px)
- [ ] Sidebar is w-60 (240px) with three labeled groups: Main, Club, Personal
- [ ] Main group: Overview (/admin/overview), Calendar (/calendar), Events (/events),
      Lessons (/admin/lessons)
- [ ] Club group: Members (/admin/members), Courts (/admin/courts),
      Club Settings (/admin/settings), Audit Log (/admin/audit-log)
- [ ] Personal group: Profile (/profile)
- [ ] Active route shows accent indicator bar and highlighted background
- [ ] /admin/members/{id} correctly activates the Members nav item

### 24C-2: Desktop sidebar — pro view

- [ ] Sign in as pro on a desktop
- [ ] Sidebar shows flat list: Calendar, Events, Lessons (/admin/lessons),
      Bookings, Profile
- [ ] No grouped section headers
- [ ] Lessons link is active on /admin/lessons

### 24C-3: Desktop sidebar — member view

- [ ] Sign in as member on a desktop
- [ ] Sidebar shows: Calendar, Events, Bookings, Profile
- [ ] No Lessons link and no admin items visible

### 24C-4: Mobile nav — fixed items by role

- [ ] Admin/Pro on mobile: bottom nav shows 5 items:
      Calendar, Events, Lessons, Bookings, More
- [ ] Member on mobile: bottom nav shows 4 items:
      Calendar, Events, Bookings, More (no Lessons)
- [ ] Tapping Calendar/Events/Bookings navigates correctly
- [ ] "More" button shows a bottom sheet

### 24C-5: Mobile nav — More sheet (admin)

- [ ] Sign in as admin on mobile, tap More
- [ ] Sheet shows: Members, Courts, Club Settings, Profile, Notifications, Security
- [ ] Tapping a link navigates and closes the sheet

### 24C-6: Mobile nav — More sheet (member/pro)

- [ ] Sign in as member on mobile, tap More
- [ ] Sheet shows: Profile, Notifications, Security (no admin management links)
- [ ] Pro role also shows no admin management links

### 24C-7: Mobile Lessons nav — role routing

- [ ] Admin/pro: tapping Lessons navigates to /admin/lessons
- [ ] Member: no Lessons item in mobile nav (Lessons tab reached via Bookings → Lesson Requests)

### 24C-8: Profile page — no admin operational links

- [ ] Sign in as admin, open /profile
- [ ] Should NOT see Admin section with Overview, Members, Courts, Settings, Audit Log
- [ ] Should still see: name/email/role, edit form, My Lesson Requests, Notifications,
      Security, Help, Sign Out

### 24C-9: Profile page — pro view

- [ ] Sign in as pro, open /profile
- [ ] No Admin section (Overview link removed)
- [ ] All personal account sections still present

### 24C-10: AdminRequestLessonSheet — desktop modal

- [ ] Sign in as admin on desktop, open /admin/lessons
- [ ] Click "Create Lesson Request"
- [ ] Sheet opens as a centered modal (max-w-2xl, rounded, backdrop)
- [ ] Escape key closes the modal
- [ ] Clicking outside the modal closes it
- [ ] Desktop close ×  button from ResponsiveSheet is visible; component's ✕ hidden

### 24C-11: AdminRequestLessonSheet — mobile sheet

- [ ] On mobile, "Create Lesson Request" opens as a bottom sheet
- [ ] Component's ✕ close button is visible on mobile
- [ ] Back button functions across all 5 steps; final step shows submit + cancel

### 24C-12: LessonProSheet — desktop modal

- [ ] Sign in as admin/pro on desktop, open /admin/lessons, click a lesson request
- [ ] Sheet opens as a centered modal
- [ ] Request summary, proposed time block, and action buttons all visible
- [ ] Escape key and backdrop click close the modal

### 24C-13: LessonProSheet — mobile sheet

- [ ] On mobile, clicking a lesson request opens as a bottom sheet
- [ ] Component's ✕ visible; all action buttons functional

### 24C-14: Admin proposal via propose_lesson_time

- [ ] Sign in as admin, open a pending lesson request in LessonProSheet
- [ ] Click "Propose a Time" → TimePicker form shows
- [ ] Select a future date, start time, and court → click "Send Proposal"
- [ ] Request status becomes 'proposed'; last_actor_role = 'admin' in DB
- [ ] Member receives lesson_time_proposed notification

### 24C-15: Admin proposal blocked on non-pending

- [ ] Open a proposed or confirmed request as admin
- [ ] "Propose a Time" button should NOT be visible

### 24C-16: Request Lesson button — member detail page

- [ ] Sign in as admin, open /admin/members/{id} for a member in a club with pros
- [ ] "Request Lesson" button is visible below the member stats card
- [ ] Button uses primary-action style (dark background, white text, rounded-xl, py-3)
- [ ] Clicking opens AdminRequestLessonSheet with member pre-selected (skip member step)

---

## Phase 24D — Member Bookings Consolidation & Lesson-Action UX

### 24D-1: /lessons redirect

- [ ] Navigate to /lessons as a member → immediately redirects to /my-schedule?tab=lessons
- [ ] Navigate to /lessons?request=1 → redirects to /my-schedule?tab=lessons&request=1
      (opens Request Lesson sheet on arrival)
- [ ] Old notification target_path values pointing to /lessons still land on Lesson Requests tab

### 24D-2: Bookings page — tab bar

- [ ] Sign in as member, open /my-schedule
- [ ] Three tabs visible: Upcoming, Lesson Requests, Past
- [ ] Active tab has dark pill background; inactive tabs have gray background
- [ ] Clicking each tab changes the URL (soft navigation) and shows correct content

### 24D-3: Upcoming tab content

- [ ] Upcoming tab shows upcoming court reservations and event signups (existing behavior)
- [ ] Confirmed upcoming lessons appear in an "Upcoming Lessons" section below the schedule
- [ ] Clicking a confirmed lesson card navigates to /my-schedule?tab=lessons
- [ ] No "Request a Lesson" CTA banner on Upcoming tab
- [ ] Cancel / Leave / Accept / Pass actions work as before

### 24D-4: Lesson Requests tab content

- [ ] Lesson Requests tab shows all member lesson requests (pending, proposed, confirmed, historical)
- [ ] "+ Request Lesson" button appears when pros are available
- [ ] Clicking "+ Request Lesson" opens the request sheet
- [ ] Request cards show correct status badges
- [ ] Tapping a card opens LessonRequestDetail sheet
- [ ] Historical requests appear in a collapsed "Past requests" section

### 24D-5: Past tab content

- [ ] Past tab shows past event participation (same as previous PastEventsSection)
- [ ] Expand / collapse behavior unchanged
- [ ] No lesson requests mixed into past events

### 24D-6: RequestLessonSheet — responsive overlay

- [ ] On desktop (≥ 768px), Request Lesson opens as a centered modal
- [ ] Escape and backdrop click close the modal
- [ ] Desktop close × from ResponsiveSheet is visible; component's ✕ hidden on desktop
- [ ] On mobile, opens as a bottom sheet with component ✕ visible
- [ ] Back button and all 4 steps function correctly

### 24D-7: LessonRequestDetail — responsive overlay

- [ ] On desktop, LessonRequestDetail opens as a centered modal
- [ ] Accept Proposed Time, Decline Proposal, Withdraw, Cancel Lesson work as before
- [ ] Mobile: opens as a bottom sheet

### 24D-8: Pro terminology in member-facing UI

- [ ] No instance of "provider" (capital or lowercase) appears in member-facing lesson UI
- [ ] Review step in RequestLessonSheet shows "Pro" label
- [ ] LessonRequestDetail shows "Pro" label
- [ ] Error state shows "Unable to load Pros" (not "lesson providers")
- [ ] Empty no-pros message says "no active Pro available"

### 24D-9: Pro terminology in admin-facing UI

- [ ] AdminRequestLessonSheet step heading says "Choose a Pro" (not "Choose a provider")
- [ ] Empty state says "No Pros available."
- [ ] Review step label says "Pro" (not "Provider")
- [ ] Note field label says "Shared request info for the Pro (optional)"
- [ ] LessonProSheet "Reassign Pro" button (not "Reassign Provider")

### 24D-10: Propose a Time — admin card action

- [ ] Sign in as admin, open /admin/lessons
- [ ] Pending request cards show "Propose a Time" button below the status line
- [ ] Proposed/confirmed/declined cards do NOT show "Propose a Time"
- [ ] Clicking "Propose a Time" opens LessonProSheet directly in proposal mode
      (TimePicker shown immediately, not the default action buttons)
- [ ] Clicking elsewhere on the card opens the sheet in default mode
- [ ] Status badge is non-interactive (informational span only)

### 24D-11: Propose a Time — pro card action (assigned only)

- [ ] Sign in as pro, open /admin/lessons
- [ ] Pending cards assigned to THIS pro show "Propose a Time"
- [ ] Pending cards assigned to a DIFFERENT pro do NOT show "Propose a Time"
- [ ] "Propose a Time" opens in propose mode directly

### 24D-12: Member profile — lesson link updated

- [ ] Sign in as member, open /profile
- [ ] "My Lesson Requests" link navigates to /my-schedule?tab=lessons (not /lessons)

### 24D-13: Bookings nav active state

- [ ] When on /my-schedule?tab=lessons, the "Bookings" desktop nav item is active
- [ ] When on /my-schedule?tab=past, the "Bookings" nav item is active
- [ ] BottomNav "Bookings" item is active on all /my-schedule URLs

### 24D-14: Reservation created only on member acceptance

- [ ] Submit a lesson request as a member → no court reservation appears in /calendar
      or admin reservation list
- [ ] Pro proposes a time → status changes to 'proposed'; still no reservation
- [ ] Member accepts the proposal → status changes to 'confirmed'; a court reservation
      now appears for the lesson time (accept_lesson_proposal creates it atomically)
- [ ] Lesson card on Upcoming tab is NOT present before acceptance; appears after
- [ ] Declining the proposal does NOT create a reservation; status returns to 'pending'

---

## Regression

- [ ] Member can submit lesson requests via Bookings → Lesson Requests tab (submit_lesson_request RPC)
- [ ] Pro can accept/decline/propose via /admin/lessons detail sheet
- [ ] Admin can propose a time via card button or full detail sheet
- [ ] Member can view upcoming schedule and past events on /my-schedule
- [ ] Member can cancel court reservations and leave events from Upcoming tab
- [ ] Admin can manage members (role change, activate/deactivate) on /admin/members
- [ ] Notifications bell still shows lesson notifications correctly
- [ ] Notification links to /lessons redirect correctly to Lesson Requests tab
