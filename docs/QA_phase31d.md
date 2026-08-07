# Phase 31D — Communications UX Consolidation — QA

Manual/UI only, except where noted. **Requires migration
`0104_my_communication_settings.sql` to be applied** (in addition to 0102 and
0103, already applied) — the corrected code in this round calls
`get_my_communication_settings()` by name and will fail closed (safe error
shown, not a crash) until that migration is applied. Scenario 20 below
re-confirms none of the Phase 31C delivery behavior moved or regressed.

Seed data: at least one Member/Pro account with no phone, one with a phone
but SMS opted out, and one with a phone and SMS opted in; one Admin account
**with a real phone number on file** (the exact condition that exposed the
root-cause defect — retest this specific case first); one Pro account
(`is_lesson_provider = true`) and one plain Member account, both with lesson
history, for the role-aware lesson-preference check. Run the SMS-configured
scenarios once with Twilio env vars set, and once with them unset.

---

## 1. Existing phone displayed consistently under `/profile` and `/profile/notifications`

- As the Admin (or any user) with a real, saved phone number:
  - Confirm `/profile` shows the correct number (unchanged — via
    `get_current_account_context()`).
  - Confirm `/profile/notifications` → "Delivery methods" → "Text messages"
    shows the **same** number, formatted (e.g. `(518) 578-8556`), not "No
    phone number added."
- This is the exact regression this checkpoint fixes: before the fix, this
  page showed "No phone number added" for a user who plainly had a phone
  under `/profile`, because the raw query selecting `sms_opt_in` alongside
  `phone` was denied in full by a column-level SELECT grant gap (migration
  0079 never added `sms_opt_in` to the grant list) and the resulting error
  was discarded and treated as "no phone."

## 2. Test SMS uses that same phone

- As the same Admin, open `/admin/settings` → Delivery diagnostics → Test
  SMS, with SMS enabled in their own preferences.
- **Expected:** the test message send succeeds (or fails only for a reason
  unrelated to contact resolution, e.g. Twilio misconfiguration) — it must
  **not** return "Add a phone number to your profile first." when a phone
  is genuinely on file. This confirms `sendTestSms` now resolves contact
  info through `get_my_communication_settings()` instead of the same broken
  raw query.

## 3. A lookup error is not presented as a missing phone

- Simulate a `get_my_communication_settings()` failure (e.g. temporarily
  revoke `authenticated`'s EXECUTE on it, or call it with an invalid
  session) and reload `/profile/notifications`.
- **Expected:** the "Text messages" row shows "Communication settings could
  not be loaded. Please refresh and try again." — **not** "No phone number
  added," and **no** interactive SMS toggle renders in this state (confirm
  no `role="switch"` element exists in the DOM for Text messages while the
  error is showing).
- Do the same for `sendTestSms` (simulate the same failure): confirm it
  returns "Communication settings could not be loaded. Please refresh and
  try again." — not "Add a phone number to your profile first." — and that
  no raw Postgres/Supabase error text ever appears in the response.

## 4. Genuine null phone still shows the correct add-phone state

- As a Member/Pro who has genuinely never added a phone number:
  - **Expected:** "Text messages" shows "No phone number added" and an "Add
    phone number" link to `/profile`, the toggle is visibly disabled, and an
    inline hint ("Add a phone number before enabling text notifications.")
    is shown — this is the correct, successful-lookup, genuinely-null case,
    distinct from scenario 3's failed-lookup case.

## 5. SMS opt-in/out still works

- With a phone on file and SMS configured, toggle on: confirm
  `update_sms_preference` fires, and `profiles.sms_opt_in`,
  `sms_opted_in_at`, `sms_opted_in_ip` are all set.
- Toggle off: confirm `sms_opt_in = false` and the consent timestamp/IP are
  cleared. No control anywhere allows editing `sms_opted_in_at` directly.
- With SMS not configured (Twilio env vars unset): confirm no "Text
  messages" row renders at all inside "Delivery methods" — only the static
  "Email" row remains, exactly as before this checkpoint's layout change.

## 6. "How you receive notifications" contains In-app, Email, and Text rows

- Load `/profile/notifications`.
- **Expected:** one section titled "How you receive notifications"
  containing, in order: an "In-app notifications" row, an "Email
  notifications" row, and — only when SMS is configured and the
  communication-settings lookup succeeds — a "Text notifications" row. No
  separate top-level "Delivery methods" or "Text messages" section exists
  outside this one card.

## 6a. In-app shows "Always on" and has no toggle

- **Expected:** the "In-app notifications" row shows the status text
  "Always on" (not a toggle, not a colored dot alone) and the description
  "Important booking, event, waitlist, and lesson updates appear in your
  notification bell." Confirm there is no interactive control in this row
  (no `role="switch"`, no button, no link).
- Confirm the rendered text never says or implies "push notification,"
  "Apple," "Android," "APNs," "FCM," or any device-level notification
  capability — this app has no such feature.

## 6b. Email shows "Manage below" and has no global toggle

- **Expected:** the "Email notifications" row shows the status text "Manage
  below" and the description "Email alerts are enabled by default. Choose
  which categories you want below." Confirm there is no toggle or checkbox
  in this row — only the per-category toggles in the collapsed groups
  further down the page control email.

## 6c. Email categories default to enabled when no stored preference exists

- For a user with no rows in `notification_preferences` for a given kind,
  confirm that kind's toggle renders "on" — unchanged default behavior from
  before this checkpoint, now stated explicitly in the Email row's copy.

## 6d. SMS remains optional, requires explicit opt-in, and does not claim parity with email

- Confirm the "Text notifications" row's description reads "Optional text
  alerts for supported transactional updates." — not any wording implying
  SMS mirrors the email categories one-to-one (e.g. not "the same alerts as
  email" or "for every email category below").
- Re-confirm scenarios 4–5 below (no-phone blocking, opt-in/opt-out,
  lookup-error handling) are unaffected by this wording-only change.

## 7. Email groups are collapsed by default

- Load `/profile/notifications` fresh (no prior interaction with this
  session/page).
- **Expected:** "Reservations," "Events & waitlist," "Lessons" (if shown —
  see scenario 11), and "Club announcements" all render as closed
  `<details>` elements. No group's toggles are visible until its summary is
  clicked or activated by keyboard.

## 8. Enabled counts are accurate

- Before opening any group, read each summary's count (e.g. "3 of 4
  enabled").
- Open the group and count the actual enabled toggles — they must match.
- Toggle one off, then re-collapse (or just observe without collapsing):
  confirm the count updates immediately (e.g. "2 of 4 enabled") without a
  page reload.

## 9. Individual email toggles still save

- Inside any expanded group, toggle a preference off then back on.
- **Expected:** identical behavior to before this checkpoint —
  `update_notification_preference` RPC call, optimistic update,
  revert-on-error. Confirm the `notification_preferences` row reflects the
  new state after each toggle.

## 10. Events and waitlist appear in one group

- Expand the "Events & waitlist" group.
- **Expected:** it contains all five of: Event join confirmations, Event
  cancellations, Event updated, Waitlist spot offers, Waitlist
  confirmations — no separate "Events" and "Waitlist" groups exist anymore.

## 11. Pro-only lesson request setting is role-aware

- As a Pro (`is_lesson_provider = true`): expand "Lessons" — confirm
  "Lesson request received" is present, alongside the four Member-facing
  lesson rows (proposed, confirmed, declined, cancelled).
- As a plain Member (not a lesson provider): expand "Lessons" — confirm
  "Lesson request received" is **absent**, but all four Member-facing rows
  (proposed, confirmed, declined, cancelled) remain visible and toggleable
  — this is presentation-only; the underlying `notification_preferences`
  row for `lesson_request_received` (if one exists for that user) is
  untouched, and the enabled count for that Member's "Lessons" group is out
  of 4, not 5.
- Confirm no delivery or database change occurred — this check is purely
  about which rows render.

## 12. Mobile, keyboard, screen-reader, and dark-mode checks

- **Mobile (375px):** "Delivery methods" and each collapsed group's summary
  row remain fully readable and tappable with no horizontal overflow; the
  phone-number row and its link wrap or truncate gracefully.
- **Keyboard:** Tab to each group's `<summary>` — Enter/Space opens and
  closes it with a visible focus ring. Tab to the SMS toggle — it announces
  as a switch with label "Text notifications" and reflects checked state;
  when disabled (no phone), it is announced as disabled and its
  `aria-describedby` hint is reachable.
- **Screen reader:** the failed-lookup error (`role="alert"`), the no-phone
  hint (`role="status"`), and each individual toggle's `aria-label` are all
  announced correctly.
- **Dark mode:** re-check "Delivery methods," each collapsed/expanded
  group, the enabled-count text, and the disabled-toggle state — all text
  remains legible against its background.

## 13. Admin Delivery diagnostics remains unchanged apart from the corrected Test SMS lookup

- `/admin/settings` → Delivery diagnostics: confirm it is still closed by
  default, still shows "Email: Configured/Not configured" and "SMS:
  Configured/Not configured," still shows Test SMS only when configured,
  and still ends with the "provider acceptance does not guarantee delivery"
  note — no new panel, no recipient history, no delivery counts, no Twilio
  trial-account or carrier-error-code text was added.
- The only functional change in this section is Test SMS's contact
  resolution (scenario 2 above) — its button, success/error presentation
  (`Sent — SID: ...` / safe error text), and placement are otherwise
  identical to the prior Phase 31D round.

---

## 14. No credentials or environment-variable names appear in rendered UI

- View source / inspect rendered HTML on both `/profile/notifications` and
  `/admin/settings`.
- **Expected:** no occurrence of `RESEND_API_KEY`, `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, or `TWILIO_FROM_NUMBER` as text, in any data
  attribute, or in any inline script/JSON.

## 15. Admin cannot opt another Member into SMS

- As an Admin, inspect `/admin/settings` end to end.
- **Expected:** no control anywhere can set or view another user's
  `sms_opt_in`. `updateSmsPreference` only ever operates on `auth.uid()`;
  `get_my_communication_settings()` (migration 0104) derives the caller
  solely from `auth.uid()`, accepts no parameters, and returns no other
  user's data — confirm by code inspection that no Admin-facing call passes
  a target Member id to either.

## 16. Phone update under `/profile` is reflected under `/profile/notifications`

- Update the phone number at `/profile`, save successfully.
- Navigate to `/profile/notifications` (both via in-app link and via a hard
  refresh / new tab).
- **Expected:** the new number is displayed in "Delivery methods" in both
  cases (`revalidatePath("/profile/notifications")` on `updateProfile`,
  unchanged from the prior round).

## 17. Announcement composer still works

- Send a test announcement as Admin.
- **Expected:** identical behavior to `docs/QA_phase31c.md` scenario 11 —
  unchanged `send_announcement_v2` call, preference filtering, recipient
  count, and delivery.

## 18. Existing notification bell and communication delivery regression

- Trigger at least one reservation/event/waitlist/announcement flow from
  `docs/QA_phase31c.md` end to end.
- **Expected:** in-app notification, email, and SMS delivery all behave
  exactly as verified in Phase 31C — this checkpoint touched no dispatch
  helper, no notification-identity logic, no migration 0102/0103 function,
  and no Twilio/Resend credential handling. The notification bell
  (`NotificationSheet.tsx`/`NotificationBell.tsx`) is unaffected.

## 19. Introduction copy and site-wide terminology boundary

- Load `/profile/notifications` and read the intro paragraph immediately
  under the "← Back to Account" link.
- **Expected:** it reads exactly "Manage how Court Time contacts you.
  Important updates always appear in your notification bell." — the longer
  prior wording ("Choose which optional email and text alerts you
  receive...") no longer appears.
- View source / inspect the full rendered page (not just the "How you
  receive notifications" card) for the words "push," "Apple," "Android,"
  "APNs," "FCM," or "native app." **Expected:** none appear anywhere in the
  rendered UI. (These terms may appear in code comments or QA docs — see
  `DeliveryMethodsSection.tsx`'s header comment — distinguishing the
  in-app bell, email, and SMS channels this app has from device push
  notifications, which are not implemented and are not referenced in any
  user-facing copy.)
