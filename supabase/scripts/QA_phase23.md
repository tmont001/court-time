# Phase 23 QA — Pro Lesson & Booking Requests

Branch: `pro-booking-requests`  
Migrations: `0069_lesson_requests.sql` + `0070_lesson_competitive_foundation.sql`  
Status: ⏳ Not yet applied

---

## Pre-flight

- [ ] Migrations 0001–0068 applied and verified in Supabase
- [ ] Migration 0069 applied (core lesson lifecycle)
- [ ] Migration 0070 applied (competitive foundation)
- [ ] Three test accounts ready: member, pro, admin (all same club)
- [ ] Club has at least one active court and operating hours configured
- [ ] `pnpm dev` running locally or staging URL available

---

## 1. Database: migration verification

```sql
-- Confirm lesson_requests table and new columns exist
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'lesson_requests'
ORDER BY ordinal_position;
-- Expected: includes lesson_type_id, lesson_outcome

-- Confirm is_lesson_provider column added to profiles
SELECT column_name FROM information_schema.columns
WHERE table_name = 'profiles' AND column_name = 'is_lesson_provider';

-- Confirm is_lesson_provider defaults to false; active pros should be true
SELECT id, role, status, is_lesson_provider FROM profiles
WHERE role = 'pro' AND status = 'active' LIMIT 10;
-- Expected: is_lesson_provider = true for active pros; new rows default to false

-- Confirm competitive foundation tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('lesson_types', 'pro_availability_windows', 'pro_blackout_dates');
-- Expected: 3 rows

-- Confirm reason CHECK includes pro_lesson
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.reservations'::regclass
  AND conname = 'reservations_reason_check';

-- Confirm notification kind CHECK includes all 13 kinds
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.notifications'::regclass
  AND conname LIKE '%kind%';

-- Confirm notification_preferences kind CHECK includes all 13 kinds
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.notification_preferences'::regclass
  AND conname LIKE '%kind%';
-- Expected: includes all 5 lesson kinds

-- Confirm all lesson RPCs exist (pro_confirm_lesson_request is NOT included — removed)
SELECT proname
FROM pg_proc
JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
WHERE nspname = 'public'
  AND proname IN (
    'get_club_pros',
    'submit_lesson_request',
    'withdraw_lesson_request',
    'propose_lesson_time',
    'accept_lesson_proposal',
    'decline_lesson_proposal',
    'decline_lesson_request',
    'cancel_lesson',
    'get_my_lesson_requests',
    'get_pro_lesson_requests',
    'get_lesson_notification_id',
    'get_lesson_recipient_email',
    'get_lesson_types',
    'upsert_lesson_type',
    'archive_lesson_type',
    'mark_lesson_outcome',
    'get_pro_availability_windows',
    'upsert_pro_availability_window',
    'delete_pro_availability_window',
    'get_pro_blackouts',
    'upsert_pro_blackout',
    'delete_pro_blackout'
  )
ORDER BY proname;
-- Expected: 22 rows

-- Confirm submit_lesson_request has 6 args (NOT 5; old 5-arg signature must be dropped)
SELECT proname, pronargs, pg_get_function_arguments(oid)
FROM pg_proc
JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
WHERE nspname = 'public' AND proname = 'submit_lesson_request';
-- Expected: exactly 1 row with pronargs = 6 (p_lesson_type_id is the 6th arg)

-- Confirm pro_confirm_lesson_request does NOT exist
SELECT COUNT(*) FROM pg_proc
JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
WHERE nspname = 'public' AND proname = 'pro_confirm_lesson_request';
-- Expected: 0
```

---

## 2. RLS policy verification

```sql
-- Confirm no direct INSERT/UPDATE/DELETE policies on lesson_requests
SELECT policyname, cmd, roles
FROM pg_policies
WHERE tablename = 'lesson_requests'
ORDER BY policyname;
-- Expected: 3 SELECT policies only (lesson_requests_select_member/pro/admin)

-- Confirm competitive tables also have SELECT-only policies
SELECT tablename, policyname, cmd FROM pg_policies
WHERE tablename IN ('lesson_types', 'pro_availability_windows', 'pro_blackout_dates')
ORDER BY tablename, policyname;
```

---

## 3. Function security verification

```sql
-- Confirm security-definer with correct search_path
SELECT proname, prosecdef, proconfig
FROM pg_proc
JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
WHERE nspname = 'public'
  AND proname IN (
    'submit_lesson_request',
    'accept_lesson_proposal',
    'cancel_lesson',
    'get_lesson_notification_id',
    'get_lesson_recipient_email'
  );
-- Expected: prosecdef=true, proconfig includes 'search_path=public,pg_temp' for all
```

---

## 4. Member discoverability

**Setup:** Sign in as member with no lesson requests.

- [ ] Navigate to `/profile` (Account screen)
- [ ] Verify "Lessons" section is visible above the Admin section
- [ ] Tap "My Lesson Requests" → navigates to `/lessons`
- [ ] `/lessons` shows empty state with "No lesson requests yet."
- [ ] "Request Lesson" button visible if pros are available at the club
- [ ] Empty state also shows "Request a Lesson" CTA button if pros available

---

## 5. Member flow: submit request

**Setup:** Sign in as member.

- [ ] Navigate to `/lessons` → "Request Lesson" button visible
- [ ] Tap → RequestLessonSheet opens
- [ ] **Step 1:** Select a pro (only `is_lesson_provider = true` pros shown)
- [ ] **Step 2:** Select duration (30/45/60/90 min)
- [ ] **Step 3:** Optionally select court, enter preferred times and lesson note
- [ ] **Step 4:** Review summary → "Submit Request"
- [ ] Sheet closes, page refreshes (router.refresh) with new request showing status "Pending"
- [ ] Pro receives `lesson_request_received` notification (in-app; in same transaction as INSERT)
- [ ] Pro receives `lesson_request_received` email (async, non-blocking; uses get_lesson_recipient_email RPC)

```sql
SELECT id, member_id, pro_id, status, duration_minutes, created_at
FROM lesson_requests
ORDER BY created_at DESC LIMIT 1;
-- Expected: status='pending'
```

---

## 6. Member flow: withdraw pending request

- [ ] Tap on pending request card → LessonRequestDetail opens
- [ ] Tap "Withdraw Request" → confirmation prompt
- [ ] Tap "Yes, Withdraw" → page refreshes, request shows status "Withdrawn"

---

## 7. Pro flow: view assigned requests

**Setup:** Sign in as pro.

- [ ] Navigate to `/events` → "Lessons" tab visible in segmented control
- [ ] Tap "Lessons" → LessonsTab shows active requests count
- [ ] Pending request visible with "Awaiting your response" label
- [ ] Tap request → LessonProSheet opens

**Verify pro buttons (pending status):**
- [ ] "Propose a Time" button visible
- [ ] "Decline Request" button visible
- [ ] **NO "Confirm a Time" button** — only "Propose a Time" and "Decline Request" are available

---

## 8. Pro flow: propose a time

- [ ] Open a pending request in LessonProSheet
- [ ] Tap "Propose a Time"
- [ ] Select a future date, time slot, and court → "Send Proposal"
- [ ] Sheet closes, LessonsTab refreshes (router.refresh)
- [ ] Request status → "proposed"; card shows proposed time
- [ ] Member receives `lesson_request_proposed` notification (in-app) and email

**Member side:**
- [ ] Sign in as member → `/lessons` → request card shows "Time proposed — tap to review"
- [ ] Open request → blue proposal block with proposed time and court visible
- [ ] Tap "Accept Proposed Time"
- [ ] Server checks member availability (no conflicting reservations, events, or lessons)
- [ ] Page refreshes, request status → "confirmed"; reservation created atomically
- [ ] Both parties receive `lesson_request_confirmed` notification (in-app) and email

**Member decline path:**
- [ ] New proposal → member opens → taps "Decline Proposal"
- [ ] Page refreshes, request status → "pending" (back to awaiting pro)

---

## 9. Pro flow: decline request

- [ ] Pro opens a pending request → "Decline Request"
- [ ] Enter optional decline reason → "Decline Request"
- [ ] Page refreshes, request status → "declined"
- [ ] Member receives `lesson_request_declined` notification and email
- [ ] Member opens request → decline reason visible

---

## 10. Cancel confirmed lesson

**Member cancels (within cancellation window check):**
- [ ] Member opens confirmed lesson → "Cancel Lesson"
- [ ] If within club cancellation window (default 24h): server returns `within_cancellation_window` error
- [ ] Outside window: enter reason (optional) → "Confirm Cancellation"
- [ ] Page refreshes, status → "cancelled"; linked reservation cancelled; `lesson_outcome` = 'cancelled'
- [ ] Pro receives `lesson_cancelled` notification and email

**Member tries to cancel past/started lesson:**
- [ ] Attempt cancel after `proposed_starts_at <= now()` → server returns `lesson_already_started`

**Pro/Admin cancels:**
- [ ] Pro or admin cancels confirmed lesson (no window restriction for pros; admins bypass both guards)
- [ ] Request status → "cancelled"; reservation cancelled; `lesson_outcome` = 'cancelled'
- [ ] Non-actor receives `lesson_cancelled` notification and email

```sql
SELECT id, status, lesson_outcome, cancellation_reason, cancelled_at
FROM lesson_requests WHERE status = 'cancelled' ORDER BY cancelled_at DESC LIMIT 1;
-- Expected: status='cancelled', lesson_outcome='cancelled'

SELECT id, status, cancellation_kind FROM reservations WHERE reason = 'pro_lesson'
ORDER BY cancelled_at DESC LIMIT 1;
-- Expected: status='cancelled', cancellation_kind IN ('member','admin')
```

---

## 11. Conflict prevention

**Court conflict blocks confirmation:**
- [ ] Create a regular member booking for Court A, 10:00–11:00 AM tomorrow
- [ ] Pro proposes lesson on Court A, 10:30 AM – 11:30 AM tomorrow
- [ ] Member attempts to accept → server rejects with `pro_has_conflict` (GiST EXCLUDE)

**Pro event conflict blocks:**
- [ ] Pro participates in an event at 2:00 PM tomorrow
- [ ] Proposal overlapping 2:00 PM → `pro_has_event_conflict`

**Member conflict blocks accept:**
- [ ] Member has a confirmed reservation at 10:00 AM tomorrow
- [ ] Member accepts proposal for 10:30 AM tomorrow → `member_has_conflict`

**Pro blackout date blocks:**
- [ ] Insert blackout: `SELECT upsert_pro_blackout(current_date + 7, 'vacation', '<pro_id>')`
- [ ] Propose a lesson on that date → `pro_on_blackout`

**Operating hours blocks:**
- [ ] Propose time at 11 PM (outside hours) → `outside_operating_hours`

---

## 12. Calendar rendering

- [ ] Navigate to `/calendar`
- [ ] Go to date with a confirmed pro lesson
- [ ] Court block appears (striped, since reason ≠ 'member_booking')
- [ ] Duration matches lesson duration

---

## 13. Admin filters (Lessons tab + admin/lessons page)

**Setup:** Sign in as admin with multiple pros who each have requests.

- [ ] Navigate to `/events` → "Lessons" tab
- [ ] Pro filter dropdown visible (appears when >1 pro has requests)
- [ ] Filter by a specific pro → only that pro's requests shown
- [ ] "All pros" option clears the filter
- [ ] Navigate to `/admin/lessons` → all club lesson requests visible

---

## 14. Notification preferences: lesson kinds

- [ ] Sign in as any user → `/profile/notifications`
- [ ] Five lesson preference toggles visible:
  - "Lesson request received" (for pros)
  - "Lesson time proposed"
  - "Lesson confirmed"
  - "Lesson request declined"
  - "Lesson cancelled"
- [ ] Toggle "Lesson request received" off → saved (enabled = false)
- [ ] Confirm email is not sent for that kind after next lesson request to that pro

```sql
-- Verify notification_preferences accepts lesson kinds
SELECT update_notification_preference('lesson_request_received', false);
SELECT * FROM notification_preferences WHERE kind = 'lesson_request_received';
-- Expected: enabled = false
```

---

## 15. Email dispatch: cross-user RPC

Lesson email dispatch uses `get_lesson_recipient_email` (not `get_user_email_for_notification`)
because the latter requires the caller to be the recipient or an admin/pro. A member dispatching
email to a pro would fail that guard. `get_lesson_recipient_email` authorizes by lesson-party
membership (caller must be member, pro, or admin on the same lesson and same club).

```sql
-- As pro, look up email for the member on a lesson request:
SELECT get_lesson_recipient_email('<request_id>', '<member_user_id>');
-- Expected: member's email address (not null)

-- As member, look up email for the pro:
SELECT get_lesson_recipient_email('<request_id>', '<pro_user_id>');
-- Expected: pro's email address (not null)

-- As unrelated same-club user: should return null
SELECT get_lesson_recipient_email('<request_id>', '<any_user_id>');
-- Expected: null

-- Also verify get_lesson_notification_id works cross-user (needed for email dedup)
SELECT get_lesson_notification_id('<request_id>', '<member_user_id>', 'lesson_request_confirmed');
-- Expected: jsonb with {id: "...", body: "..."} (not null)
```

---

## 16. Competitive foundation: lesson types (backend-only, no UI)

All lesson type management is via RPC only. There is no admin UI in this phase.
RPCs that require `auth.uid()` must be called through an authenticated Supabase client
(app or `supabase.rpc(...)` with a signed-in session). The SQL Editor runs as the service
role — `auth.uid()` returns null there, causing RPCs to return `not_authenticated`.

```sql
-- Create a lesson type as admin
SELECT upsert_lesson_type(
  null,            -- p_id (null = create)
  'Private Lesson',
  'One-on-one coaching',
  '{30,45,60}'::int[],
  1,               -- max_participants
  75.00,           -- rate_amount
  'USD',           -- rate_currency
  null             -- rate_notes
);

-- Verify type visible via RPC
SELECT * FROM get_lesson_types();
-- Expected: Private Lesson row

-- Attempt invalid duration array → error
SELECT upsert_lesson_type(null, 'Test', null, '{}'::int[], 1, null, null, null);
-- Expected: 'allowed_durations_empty' error

-- Archive a type (soft delete)
SELECT archive_lesson_type('<type_id>');
SELECT * FROM get_lesson_types();
-- Expected: archived type no longer returned
```

---

## 17. Competitive foundation: pro availability windows (backend-only, no UI)

Availability windows are informational only. The proposal flow does not enforce them;
operators read them to make manual scheduling decisions. Overlapping windows are explicitly
allowed (e.g., a pro can mark Mondays 9am–12pm and 9am–6pm simultaneously).
There is no admin UI in this phase. Call these RPCs via authenticated client (see Section 16 note).

```sql
-- Set a recurring availability window (Mon 9am-12pm)
SELECT upsert_pro_availability_window(1, '09:00', '12:00', '<pro_id>', null);

-- Overlapping window is allowed (informational, not enforced)
SELECT upsert_pro_availability_window(1, '09:00', '18:00', '<pro_id>', null);

-- Retrieve windows
SELECT * FROM get_pro_availability_windows('<pro_id>');
-- Expected: 2 rows, both day_of_week=1

-- Delete a window
SELECT delete_pro_availability_window('<window_id>');

-- Attempt invalid time range → error
SELECT upsert_pro_availability_window(1, '12:00', '09:00', '<pro_id>', null);
-- Expected: 'invalid_time_range' error

-- Attempt invalid day_of_week → error
SELECT upsert_pro_availability_window(7, '09:00', '10:00', '<pro_id>', null);
-- Expected: 'invalid_day_of_week' error
```

---

## 18. Competitive foundation: lesson outcomes (backend-only, no UI)

Outcome recording is via RPC only; there is no UI in this phase.
The assigned pro or any same-club admin (regardless of `is_lesson_provider`) may record.
`cancel_lesson` is the only path that produces `lesson_outcome = 'cancelled'`.
`mark_lesson_outcome` rejects 'cancelled' as an input — cancellation must go through `cancel_lesson`.

These RPCs require an authenticated caller. Call them via the app or an authenticated
Supabase client (e.g. `supabase.rpc(...)` with a signed-in session), not as a plain
SQL Editor query which runs under the service role and bypasses `auth.uid()` checks.

```sql
-- Verify outcome stored (status stays 'confirmed', only lesson_outcome changes).
-- Run mark_lesson_outcome via authenticated client first:
--   await supabase.rpc('mark_lesson_outcome', { p_request_id: '...', p_outcome: 'completed' })
SELECT id, status, lesson_outcome FROM lesson_requests WHERE id = '<request_id>';
-- Expected: lesson_outcome = 'completed', status = 'confirmed'

-- Repeat with 'member_no_show' and 'pro_no_show' — both accepted.

-- Attempt 'cancelled' via mark_lesson_outcome → rejected
--   await supabase.rpc('mark_lesson_outcome', { p_request_id: '...', p_outcome: 'cancelled' })
-- Expected: 'invalid_outcome' error (cancellation must use cancel_lesson instead)

-- Attempt to record outcome before lesson starts → error
--   await supabase.rpc('mark_lesson_outcome', { p_request_id: '<future_id>', p_outcome: 'completed' })
-- Expected: 'lesson_not_yet_started' error

-- Attempt to record outcome on a non-confirmed request → error
--   await supabase.rpc('mark_lesson_outcome', { p_request_id: '<pending_id>', p_outcome: 'completed' })
-- Expected: 'invalid_status_for_outcome' error
```

---

## 19. is_lesson_provider: designation (backend-only, no UI)

`is_lesson_provider` is set to `true` for existing active pros via migration backfill.
New rows default to `false`. Admin UI to change this setting is deferred to a future phase.
An admin can appear in `get_club_pros()` only if `is_lesson_provider = true`; by default admins are excluded.

```sql
-- Verify active pros are lesson providers after migration
SELECT id, role, status, is_lesson_provider FROM profiles
WHERE role = 'pro' AND status = 'active';
-- Expected: is_lesson_provider = true

-- Verify admin is NOT a lesson provider by default
SELECT id, role, status, is_lesson_provider FROM profiles
WHERE role = 'admin';
-- Expected: is_lesson_provider = false (unless manually updated)

-- Manually enable admin as lesson provider (if needed for testing)
UPDATE profiles SET is_lesson_provider = true WHERE id = '<admin_id>';
```

---

## 20. My Schedule integration

- [ ] Navigate to `/my-schedule`
- [ ] "Lesson requests" section visible above past events
- [ ] Pending request shows "Awaiting response" label
- [ ] Proposed request shows "Time proposed — review" label
- [ ] Confirmed request shows court name and date
- [ ] Tapping any row navigates to `/lessons`
- [ ] Regular court reservations still show correctly (pro_lesson reason excluded)

---

## 21. Cross-club isolation

```sql
-- get_club_pros only returns pros in caller's club
SELECT * FROM get_club_pros();
-- Expected: only returns is_lesson_provider=true pros/admins in auth.uid()'s club

-- get_lesson_recipient_email rejects cross-club access
-- (caller and target must share club_id)
```

---

## 22. TypeScript types alignment

```bash
pnpm tsc --noEmit
# Expected: 0 errors
```

- [ ] `lesson_requests` table types in `src/lib/db/types.ts` include `lesson_type_id`, `lesson_outcome`
- [ ] `get_lesson_notification_id` RPC present in db/types.ts
- [ ] `get_lesson_recipient_email` RPC present in db/types.ts
- [ ] `pro_confirm_lesson_request` is NOT in db/types.ts (removed)
- [ ] `get_club_pros` return includes `is_lesson_provider`
- [ ] Competitive foundation RPCs all typed
- [ ] `localDateTimeToUTC` exported from `src/lib/timezone.ts`

---

## 23. Build and lint

```bash
git diff --check
pnpm tsc --noEmit
pnpm build
echo "BUILD_EXIT=$?"
git status --short
git diff --stat
git diff --name-status
```

Expected:
- `git diff --check`: no whitespace errors
- `pnpm tsc --noEmit`: 0 type errors
- `pnpm build`: successful (BUILD_EXIT=0)

---

## 24. Regression checks

- [ ] `/calendar` renders without errors for member, pro, admin
- [ ] `/events` Upcoming and Manage tabs still work for admin/pro
- [ ] `/events` Upcoming list still works for members (no Lessons tab shown to members)
- [ ] `/my-schedule` still shows regular reservations and events correctly
- [ ] `/admin/overview` all existing sections load without error
- [ ] Waitlist offer flow (`/events` → offer accept/decline) unaffected
- [ ] Notification delivery for existing kinds (event_joined, etc.) unaffected
- [ ] Profile page renders correctly for member (shows Lessons section); for admin (shows Lessons + Admin sections)
- [ ] Notification preferences page shows all 13 kinds (8 existing + 5 lesson kinds)

---

## 25. Error scenarios

- [ ] Member tries to submit request to pro in another club → `pro_not_found`
- [ ] Member tries to request lesson from themselves → `cannot_request_yourself`
- [ ] Pro tries to propose with duration not in lesson type's allowed_durations → `duration_not_allowed_for_type`
- [ ] Member tries to accept expired proposal → `proposed_time_in_past`
- [ ] Member tries to cancel past lesson → `lesson_already_started`
- [ ] Member tries to cancel within window → `within_cancellation_window`
- [ ] Cancel already-cancelled lesson → `invalid_status_for_cancel`
- [ ] Submit with note > 500 chars → `note_too_long`
- [ ] Blackout reason > 300 chars → `reason_too_long`
- [ ] Lesson type name empty → `name_required`
- [ ] Lesson type name > 100 chars → `name_too_long`
- [ ] Lesson type with empty durations array → `allowed_durations_empty`
- [ ] Lesson type with non-multiple-of-15 duration → `allowed_durations_invalid`
- [ ] Lesson type with rate_amount ≤ 0 → `rate_amount_invalid`
- [ ] Lesson type with max_participants < 1 → `max_participants_invalid`
- [ ] Blackout for past date → `blackout_date_in_past`

---

## Sign-off checklist

| Item | Status |
|------|--------|
| Migration 0069 applied | ⏳ |
| Migration 0070 applied | ⏳ |
| Member discoverability from profile page | ⏳ |
| Member can submit request | ⏳ |
| Pro can propose time → member accepts | ⏳ |
| Pro has no "Confirm a Time" button | ⏳ |
| Decline path works both sides | ⏳ |
| Cancel: past-lesson guard enforced | ⏳ |
| Cancel: window enforced for members | ⏳ |
| Cancel: reservation removed from calendar | ⏳ |
| Cancel: lesson_outcome set to 'cancelled' | ⏳ |
| Court conflict blocks confirmation | ⏳ |
| Member conflict blocks acceptance | ⏳ |
| Pro blackout date blocks confirmation | ⏳ |
| Operating hours blocks confirmation | ⏳ |
| Email dispatch cross-user (get_lesson_recipient_email) | ⏳ |
| Notification preferences shows 5 lesson kinds | ⏳ |
| Admin pro filter works in LessonsTab | ⏳ |
| Lesson types CRUD works (SQL only, no UI) | ⏳ |
| Pro availability windows CRUD works (SQL only, no UI) | ⏳ |
| Pro blackout dates CRUD works | ⏳ |
| Lesson outcome recording works (SQL only, no UI) | ⏳ |
| is_lesson_provider: active pros backfilled to true | ⏳ |
| submit_lesson_request: exactly 6-arg signature in pg_proc | ⏳ |
| pro_confirm_lesson_request absent from pg_proc | ⏳ |
| TypeScript: 0 errors | ⏳ |
| Build: exit 0 | ⏳ |
| Regression: no existing flows broken | ⏳ |

---

## Runtime & UX Correction Pass (0073)

### Proposal-time conflict validation

| Test | Status |
|------|--------|
| Propose on occupied court → error "That court is already occupied at the selected time." | ⏳ |
| Propose outside operating hours → error "That time falls outside the club's operating hours." | ⏳ |
| Propose when pro has overlapping reservation → error "You already have another booking, event, or lesson at that time." | ⏳ |
| Propose when pro has overlapping event → same message as above | ⏳ |
| Propose on pro blackout date → error "You are unavailable on that date." | ⏳ |
| Propose when member has overlapping reservation → error "The member already has another booking, event, or lesson at that time." | ⏳ |
| Propose when member has overlapping confirmed lesson → same message as above | ⏳ |
| On any proposal error: sheet stays open, date/time/court preserved | ⏳ |
| On any proposal error: no notification inserted, no email sent | ⏳ |
| Valid proposal with no conflicts: succeeds and navigates away | ⏳ |

### Cancellation reason continuous typing

| Test | Status |
|------|--------|
| Tap "Cancel Lesson" or "Decline Request" → textarea appears | ⏳ |
| Type a full sentence without re-clicking → text accumulates normally | ⏳ |
| Each keystroke does not lose focus | ⏳ |
| Validation errors do not clear the typed text | ⏳ |

### Private Lesson calendar privacy

| Test | Status |
|------|--------|
| Assigned pro views calendar → lesson block shows "Pro lesson with [member name]" | ⏳ |
| Admin views calendar → lesson block shows the note ("Pro lesson with [member name]") | ⏳ |
| Unrelated member views calendar → lesson block shows "Private Lesson" only | ⏳ |
| Unrelated pro views calendar → lesson block shows "Private Lesson" only | ⏳ |
| Lesson block uses event-card structure: items-start, pt-1, px-1.5, font-semibold | ⏳ |
| No hatch pattern, no "Blocked" label on lesson blocks | ⏳ |

### Role → lesson-provider synchronization (0073)

| Test | Status |
|------|--------|
| Admin promotes member to pro → is_lesson_provider = true immediately | ⏳ |
| Promoted pro appears in member's pro picker on next request | ⏳ |
| Admin demotes pro to member → is_lesson_provider = false | ⏳ |
| Demoted member no longer appears in pro picker | ⏳ |
| Admin changes pro to admin → is_lesson_provider unchanged | ⏳ |
| Existing active pros with is_lesson_provider = false repaired by migration | ⏳ |
| Admin page refreshes correctly after role change | ⏳ |
