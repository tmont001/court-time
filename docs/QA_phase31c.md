# Phase 31C — Cross-User Email/SMS Dispatch Cutover — QA

Manual/UI only. Requires migrations `0102_communications_delivery_identity.sql`
and `0103_sms_delivery_reliability.sql` both applied. Run every case below
with **two real, separately-authenticated accounts** — the failure mode this
checkpoint fixes is silent (no error, no email, no SMS, no log row), so a
single-account test cannot distinguish "fixed" from "still broken."

Migration 0103 replaced the raw `profiles` read previously used for
reservation/event SMS contact resolution with domain-scoped RPCs
(`get_reservation_recipient_sms_contact`, `get_event_recipient_sms_contact`),
matching the pattern already used for waitlist
(`get_waitlist_recipient_sms_contact`), after two confirmed local
reproductions showed that raw read was not pilot-reliable (email succeeded,
SMS produced zero `notification_deliveries` rows, no error). It also added
`sms_already_delivered`, a pilot-level best-effort SMS idempotency check
mirroring `email_already_delivered`'s role for email. Scenarios 21–26 below
cover this correction specifically; scenarios 1, 2, 3, 4, and 5 already
exercise the corrected SMS paths for their respective domains and should be
re-run against the corrected code even if previously verified.

Recommended seed data: one club with an Admin, a Pro (marked
`is_lesson_provider`/pro role), and at least two Members, plus a second club
with its own Admin/Member for the cross-club isolation cases. For each
scenario, check the actual inbox/phone of the second account, not just the
Server Action's return value.

For every scenario, also confirm via SQL (Admin session, since
`notification_deliveries` is admin-scoped):

```sql
select channel, status, provider, provider_message_id, error, sent_at
  from notification_deliveries
 where notification_id = '<the notification id from the notifications table>'
 order by created_at;
```

---

## 1. Admin cancels Member reservation

- Admin cancels a Member's confirmed court reservation.
- **In-app:** Member sees a `reservation_cancelled_by_admin` bell notification.
- **Email:** Member receives "Your booking was cancelled" (if
  `RESEND_API_KEY` set and the Member's `reservation_cancelled_by_admin`
  preference is enabled — default on).
- **SMS:** Member receives an SMS (if Twilio configured, `sms_opt_in` true,
  and phone on file) — contact resolved via
  `get_reservation_recipient_sms_contact` (migration 0103), never a raw
  `profiles` read. This is the specific path confirmed broken twice locally
  before 0103; treat a received SMS here as the primary pass/fail signal for
  this whole correction.
- **notification_deliveries:** one `email` row (`sent` with
  `provider_message_id`, or `failed`/`opted_out` per preference/config) and
  one `sms` row (`sent`/`opted_out`/`no_phone`/`failed`), both referencing
  the exact notification id created by `admin_cancel_reservation_v2`.
- **Unconfigured channel:** if `RESEND_API_KEY` unset, no email row at all
  (guard 1 short-circuits before any RPC call) and no email is claimed sent.
  SMS unconfigured still writes a `failed` row (existing SMS behavior,
  unchanged).

## 2. Admin reschedules Member reservation

- Admin edits the court/date/time of a Member's confirmed reservation via
  `updateMemberReservationAdmin`.
- **In-app:** Member sees `reservation_rescheduled` (always fires for a
  material change, never preference-gated in-app).
- **Email/SMS:** as in scenario 1, driven by `get_reservation_delivery_context`
  on the exact `notification_id` `update_member_reservation` returns.
- **No-op edit** (identical values resubmitted): no notification, no
  delivery attempt of any kind.
- **notification_deliveries:** one email + one SMS row per material edit,
  keyed to that edit's exact notification id — a second edit shortly after
  must produce a second, distinct notification id and its own delivery rows,
  never reusing or double-writing the first.

## 3. Admin cancels event with confirmed, waitlisted, and offered participants

- Seed one event with a confirmed Member, a waitlisted Member, and a Member
  with an active (non-expired) offer. Admin cancels the event.
- **In-app:** all three receive `event_cancelled`.
- **Email/SMS:** all three receive email/SMS (subject to their own
  preference/opt-in/phone state) — this is the specific bug fixed in
  0102's correction round (offered participants were previously excluded
  because their status flipped to `cancelled` before the old code's
  recipient query ran). Confirm the previously-offered Member specifically
  receives their notification.
- The cancelling Admin (if also a participant, e.g. host) receives the
  in-app row but **no** email/SMS.
- **notification_deliveries:** one email + one SMS row per non-actor
  recipient, each keyed to its own exact notification id from
  `cancel_event`'s returned array.

## 4. Creator-Pro cancels their own event

- A Pro who created an event (`events.created_by` = that Pro) cancels it,
  with at least one confirmed Member participant.
- **In-app/Email/SMS:** identical to scenario 3 for the Member participant.
- Confirm the Pro's own cancellation succeeds (their role check in
  `cancel_event` passes because `created_by` matches).

## 5. Admin updates event

- Admin edits an event's time/court/capacity with two confirmed
  participants.
- **In-app:** both receive `event_updated` (always fires in-app for a
  material change).
- **Email/SMS:** both receive email/SMS via `get_event_delivery_context` on
  each exact `{notification_id, user_id}` pair `update_event` returns.
- **notification_deliveries:** one email + one SMS row per participant, no
  cross-contamination between the two participants' notification ids.

## 6. Member leaves and another Member receives a waitlist offer

- Member A has a confirmed spot; Member B is waitlisted. Member A leaves the
  event via `leaveEvent`.
- **In-app:** Member B receives `waitlist_offer`.
- **Email:** Member B receives "Spot available" — resolved via
  `get_waitlist_recipient_email`, **not** `get_user_email_for_notification`
  (Member A is neither Member B nor admin/pro, so the generic RPC would deny
  this). Confirm delivery actually reaches Member B's inbox.
- **SMS:** Member B receives SMS — resolved via
  `get_waitlist_recipient_sms_contact`, **not** a raw `profiles` query.
- **notification_deliveries:** rows keyed to the exact `notification_id`
  `leave_event_v2` returned.
- **No offer created** (Member A was waitlisted, not confirmed/offered; or
  no one was waiting): `leave_event_v2` returns `notification_id: null` —
  confirm zero delivery attempts occur.

## 7. Admin offers a waitlist spot

- Admin calls `adminOfferSpot` on a specific waitlisted Member.
- **In-app/Email/SMS:** Member receives `waitlist_offer` through the same
  exact-id path as scenario 6, this time authorized via same-club Admin
  (not `triggered_by`, though `triggered_by` is also stamped).

## 8. Pro offers a waitlist spot

- A Pro (not the recipient, not an Admin) calls `adminOfferSpot`.
- **In-app/Email/SMS:** Member receives the notification. Authorization
  succeeds specifically because `metadata.triggered_by` equals this Pro's
  id — confirm via `get_waitlist_delivery_context`/
  `get_waitlist_recipient_email` returning non-null when called as this Pro,
  and confirm a **different**, unrelated Pro calling the same RPCs against
  the same notification id gets `null` (see scenario 18).

## 9. Admin force-confirms a participant

- Admin calls `adminForceConfirm` on a waitlisted/offered Member.
- **In-app/Email/SMS:** Member receives `waitlist_promoted` via the exact
  `notification_id` `admin_force_confirm` returns.

## 10. Pro force-confirms a participant

- A Pro calls `adminForceConfirm`.
- Same as scenario 9, authorized via `metadata.triggered_by` = that Pro's id.

## 11. Admin sends an announcement

- Admin sends an announcement to a club with 3+ active Members. Before
  sending, disable the `announcement` preference for at least one of them
  at `/profile/notifications`; leave it enabled (default) for the rest.
- `send_announcement_v2`'s recipient `INSERT` is itself preference-filtered
  (`notifications` are only inserted for recipients whose `announcement`
  preference is enabled or unset — see migration 0102's `send_announcement_v2`
  body). There is a single gate, not two: the `announcement` preference
  controls whether a notification row is created at all, which in turn
  controls whether any email can follow. There is no in-app-vs-email split
  for this kind (unlike `event_updated`/`reservation_rescheduled`, where
  in-app is mandatory and only email is preference-gated).
- **Member with `announcement` preference enabled (default):**
  - **In-app:** receives the `announcement` bell notification.
  - **Email:** receives it, if `RESEND_API_KEY` is configured.
  - **notification_deliveries:** one `email` row (`sent`/`failed` per
    configuration), keyed to that recipient's own exact notification id.
- **Member with `announcement` preference disabled:**
  - **In-app:** receives **nothing** — no `announcement` row is inserted
    for them at all, not merely a suppressed email.
  - **Email:** none (there is no notification id to dispatch against).
  - **notification_deliveries:** **no row** — dispatch never runs for a
    recipient with no notification id, so there is nothing to log, not an
    `opted_out` status.
- **recipientCount** shown to the Admin equals `send_announcement_v2`'s
  `recipient_count`, which is `count(*)` over only the rows the
  preference-filtered `INSERT` actually created — i.e. it already excludes
  the preference-disabled Member. Confirm the displayed count is one less
  than the total active-Member count when exactly one Member has the
  preference disabled.
- The sending Admin is excluded from `recipient_count` and from the
  returned `notifications` array by the RPC's own `p.id <> auth.uid()`
  filter — never appears as a recipient, and no app-level check is needed
  or present to re-exclude them.
- Confirm no `created_at`-window query executes (inspect logs/network if
  possible) — delivery must work identically whether the announcement is
  the only one sent that hour or the third in five seconds (send two
  announcements back-to-back and confirm both fully and correctly deliver
  to the right recipients with no cross-contamination).
- This checkpoint does not change announcement preference design — this
  scenario only verifies Phase 31C's dispatch cutover matches the existing,
  unmodified `send_announcement_v2` preference behavior.

## 12. Duplicate Server Action execution does not duplicate email

- Trigger the same mutation twice in quick succession in a way that
  produces the *same* notification id being dispatched twice (e.g. simulate
  a retried Server Action, or manually invoke the dispatch helper twice for
  the same notification id in a test harness).
- **Expected:** exactly one `sent` (or `failed`) email row — the second
  attempt is blocked by `email_already_delivered` before any second Resend
  call, and the recipient's inbox shows exactly one email.

## 13. Email preference disabled

- Recipient disables the relevant kind's preference (e.g.
  `reservation_cancelled_by_admin`) at `/profile/notifications`, then
  triggers that flow.
- **In-app:** still appears (in-app is never preference-gated for the kinds
  in scope here).
- **Email:** not sent; `notification_deliveries` records `opted_out` for
  the `email` channel.
- **SMS:** unaffected by the email preference (SMS has its own global
  `sms_opt_in`, tested separately in scenario 14).

## 14. SMS opted out

- Recipient has `sms_opt_in = false`.
- **SMS:** not sent; `notification_deliveries` records `opted_out` for the
  `sms` channel. Email dispatch is unaffected.

## 15. Missing phone

- Recipient has `sms_opt_in = true` but `phone` is null.
- **SMS:** not sent; `notification_deliveries` records `no_phone`.

## 16. Provider failure is logged

- Temporarily misconfigure `RESEND_API_KEY` (invalid key) or trigger a
  Twilio failure (e.g. invalid `TWILIO_FROM_NUMBER`) and run any scenario
  above.
- **Expected:** `notification_deliveries` records `failed` with a non-null
  `error` message and no `provider_message_id`; the underlying mutation
  (reservation/event/waitlist/announcement) still succeeds — verify the
  Server Action returns no error to the UI.

## 17. Cross-club recipient isolation

- Using two clubs, attempt (via direct RPC call in a SQL client, authenticated
  as a Club B user) to call `get_reservation_delivery_context`,
  `get_event_delivery_context`, `get_waitlist_delivery_context`,
  `get_waitlist_recipient_email`, or `get_waitlist_recipient_sms_contact`
  against a Club A notification id.
- **Expected:** every call returns `null`. No Club A recipient contact
  info or notification body is ever returned to a Club B caller.

## 18. Unrelated Pro/Member cannot resolve delivery context/contact

- As a Pro who did **not** create the event in question and is **not** the
  `metadata.triggered_by` actor on a waitlist notification, call
  `get_event_delivery_context` / `get_waitlist_delivery_context` /
  `get_waitlist_recipient_email` / `get_waitlist_recipient_sms_contact`
  against that notification id.
- As a Member who is neither the recipient, an Admin, nor the
  `triggered_by` actor, call the same waitlist RPCs.
- **Expected:** `null` in every case — confirm this via direct RPC call
  (not just observing that the app doesn't expose a button for it).

## 19. Existing lesson email delivery remains functional

- Submit a lesson request, propose a time, confirm, decline, cancel, and
  reassign a provider — the full lesson lifecycle — between a Member and a
  Pro.
- **Expected:** every step's email fires exactly as before Phase 31C
  (lesson dispatch code — `lessons/actions.ts`, `get_lesson_notification_id`,
  `get_lesson_recipient_email` — was not modified in this checkpoint).
  Confirm no regression: this is a pure non-regression check, not a new
  behavior.

## 20. Notification bell mark-read and mark-all-read remain functional

- Open the notification bell with several unread notifications. Click one
  to mark it read; use "Mark all read" for the rest.
- **Expected:** both actions succeed exactly as before (own-row
  `is_read` UPDATE, unaffected by this checkpoint — no RLS or dispatch
  changes touch `NotificationSheet.tsx`/`NotificationBell.tsx`). Confirm no
  console/network error on either action.

---

## 21. Reservation SMS contact resolution (migration 0103)

- As the Admin, immediately after cancelling or rescheduling a Member's
  reservation (scenarios 1–2), confirm the resulting SMS actually arrives at
  the Member's phone.
- Directly (via a SQL client, authenticated as that Admin) call
  `get_reservation_recipient_sms_contact('<the notification id>')` and
  confirm it returns `{"phone": "<the Member's phone>", "sms_opt_in": true}`
  — not `null`.
- As the recipient Member themselves, call the same RPC with their own
  notification id and confirm it also returns their own contact (the
  recipient-self-access branch).

## 22. Event SMS contact resolution (migration 0103)

- Same as scenario 21, but for `get_event_recipient_sms_contact` against an
  `event_cancelled` or `event_updated` notification id from scenarios 3–5.
- As the creator-Pro of that event, confirm the RPC returns the recipient's
  contact (creator-Pro branch). As a **different**, non-creator Pro, confirm
  it returns `null` (see scenario 25).

## 23. Failed contact resolution creates a failed delivery row

- Temporarily revoke `authenticated`'s EXECUTE on one of the new 0103
  functions (or call it with a syntactically valid but nonexistent
  notification id) to force `contactError` or a `null` contact result inside
  `dispatchSmsNotification`.
- **Expected:** exactly one `notification_deliveries` row with
  `channel = 'sms'`, `status = 'failed'`, and
  `error = 'Recipient SMS contact could not be resolved.'` — never a silent
  return, never the raw Postgres/PostgREST error text in that column.

## 24. Repeated dispatch of one exact notification does not send a second SMS

- Using a seeded test harness (or by manually invoking
  `dispatchSmsNotification`/calling `sms_already_delivered` directly against
  a notification id that already has a `sent` SMS row from an earlier
  scenario), confirm:
  - `sms_already_delivered('<that notification id>')` returns `false`
    **before** any SMS has been sent for it, and `true` **after** exactly
    one `sent` row exists.
  - A second full dispatch attempt against the same notification id (e.g.
    simulating a retried Server Action) results in **no second Twilio send**
    and **no second `notification_deliveries` row** — the function returns
    immediately after `sms_already_delivered` reports `true`.
- This is pilot-level best-effort idempotency, not a database constraint —
  confirm it holds for ordinary duplicate Server Action execution, which is
  the scenario it targets.

## 25. Unrelated Pro/Member cannot resolve SMS contact

- As a Pro who did **not** create the event in question, call
  `get_event_recipient_sms_contact` against that event's notification id —
  expect `null`.
- As a Member who is neither the recipient nor an Admin (and, for a waitlist
  notification, not the `triggered_by` actor), call the matching SMS
  contact RPC — expect `null`.
- As any authenticated Pro or Member with no standing over a given
  reservation notification (not the recipient, and — for the two Member
  self-service kinds — not an Admin either), call
  `get_reservation_recipient_sms_contact` — expect `null`.
- Also confirm `sms_already_delivered` returns `false` (not an error, not
  the real answer) for each of the above unauthorized callers, even when a
  `sent` row genuinely exists — it must never disclose delivery status to a
  caller who couldn't independently prove standing over the notification.

## 26. Cross-club SMS contact resolution denied

- As an authenticated user in Club B, call
  `get_reservation_recipient_sms_contact`, `get_event_recipient_sms_contact`,
  and `sms_already_delivered` against a Club A notification id.
- **Expected:** `null` (contact RPCs) / `false` (`sms_already_delivered`) in
  every case — no Club A phone number or delivery status is ever returned to
  a Club B caller.

---

## Out of scope for this checkpoint (unchanged, self-triggered, verified safe pre-31C)

Booking confirmation (`createReservation`), event self-join
(`joinEvent`), member self-cancel via the legacy
`notifyMemberReservationCancelled` path, and waitlist offer self-accept
(`acceptWaitlistOffer`) still use their pre-existing "own-row" notification
lookups. These are unaffected because the acting user is always the
recipient (RLS already permits an own-row `SELECT`), and their underlying
RPCs were not part of migration 0102's exact-identity contracts. No action
needed; verify only that these still function (they were not touched by
this checkpoint's edits) as a smoke test alongside the above.
