# Phase 25D QA Checklist

Covers Phase 25D: Invitation and no-club onboarding experience.
Requires migrations 0079 and 0080 to be applied before testing.
Roster first_name/last_name/phone copy behavior is from migration 0067 (pre-existing).

---

## Valid Invite While Signed Out

### 25D-1: Invite page shows club and role

- [ ] Open a valid invite link `/join/<code>` while signed out
- [ ] Confirm the club name is displayed
- [ ] Confirm the invited role is displayed as "Member", "Pro", or "Admin"
- [ ] Confirm the email-restricted warning appears when the invite has a restricted email
- [ ] Confirm the restricted email address itself is NOT shown

### 25D-2: Sign In action preserves return destination

- [ ] Click "Sign in to accept" on the invite page
- [ ] Confirm navigation to `/sign-in?redirect=/join/<code>`
- [ ] Confirm the redirect parameter is present in the URL

### 25D-3: Create Account action preserves return destination

- [ ] Click "Create account" on the invite page
- [ ] Confirm navigation to `/sign-up?redirect=/join/<code>`
- [ ] Confirm the redirect parameter is present in the URL

---

## Sign In Return Preservation

### 25D-4: Sign in from invite redirects back to join page, then accepts

- [ ] Open `/join/<code>` while signed out
- [ ] Click "Sign in to accept" → sign in with a valid account (no club)
- [ ] Confirm the invite is accepted automatically (no second "Accept" click needed)
- [ ] Confirm redirect to /calendar or /welcome depending on profile completeness

### 25D-5: Sign in for existing club member goes to calendar

- [ ] Sign in from `/sign-in` (no redirect param) as a user already in a club
- [ ] Confirm redirect to /calendar (no pending invite → normal sign-in)

### 25D-6: Malformed redirect parameter falls back safely

- [ ] Navigate to `/sign-in?redirect=https://evil.example.com`
- [ ] Sign in → confirm redirect goes to /calendar (external URL rejected)
- [ ] Navigate to `/sign-in?redirect=//evil.example.com`
- [ ] Sign in → confirm redirect goes to /calendar

---

## Create Account Return Preservation

### 25D-7: New account with immediate session accepts and redirects

- [ ] (Requires email confirmation disabled in Supabase project settings)
- [ ] Open `/join/<code>` → Create account → submit form
- [ ] Confirm invite is accepted automatically
- [ ] Confirm redirect to /calendar or /welcome

### 25D-8: New account with email confirmation shows check-your-email state

- [ ] (Requires email confirmation enabled)
- [ ] Open `/join/<code>` → Create account → submit form
- [ ] Confirm "Check your email" screen with the submitted email address shown
- [ ] Confirm a link to Sign In is present on the check-your-email screen

### 25D-9: Email confirmation link lands on join page, accepts, redirects

- [ ] Click the confirmation link from the email
- [ ] Confirm redirect to /calendar or /welcome (not back to /sign-in)
- [ ] Confirm the invite was accepted (profile.club_id is set)

### 25D-10: Email confirmation preserves invite when next param is present

- [ ] Confirm that `/auth/confirm?code=<pkce>&next=/join/<code>` is the
      shape of the confirmation link in the email
- [ ] If email client strips query params and cookie is present, invite is still accepted

---

## Successful Acceptance

### 25D-11: Accept button disables during submission

- [ ] Sign in as a no-club user, open a valid `/join/<code>`
- [ ] Click "Accept Invitation"
- [ ] Confirm button text changes to "Accepting…" and is disabled
- [ ] Confirm button cannot be clicked twice

### 25D-12: Successful acceptance redirects to calendar when profile complete

- [ ] Accept an invite as a user whose profile already has first_name and last_name
- [ ] Confirm redirect to /calendar (not /welcome)

### 25D-13: Successful acceptance redirects to welcome when profile incomplete

- [ ] Accept an invite as a user with null first_name or last_name
- [ ] Confirm redirect to /welcome

### 25D-14: Roster name copies — skips redundant Welcome form

Pre-existing behavior from migration 0067. No new migration required for this case.

- [ ] Create a roster entry in the club with first_name, last_name, email, and phone
- [ ] Accept an invite as a new user registered with that same email (profile has no name)
- [ ] Confirm redirect goes to /calendar (not /welcome)
- [ ] Confirm profile.first_name and profile.last_name are set from the roster entry
- [ ] Confirm profile.phone is set from the roster entry (if profile.phone was null)

### 25D-15: Roster phone copies — existing name on profile, no phone

Pre-existing behavior from migration 0067.

- [ ] Profile has first_name and last_name but no phone
- [ ] Roster entry matches email and has a phone
- [ ] Accept invite → confirm profile.phone is set from roster
- [ ] Confirm redirect goes to /calendar (profile already had names)

### 25D-16: Existing profile data is NOT overwritten by roster

Pre-existing behavior from migration 0067.

- [ ] Profile already has first_name = "Alex", last_name = "Jones", phone = "555-1234"
- [ ] Roster entry has different name and phone
- [ ] Accept invite → confirm profile fields are UNCHANGED
- [ ] Confirm redirect goes to /calendar

---

## Welcome Form

### 25D-17: Welcome form saves first_name, last_name, phone

- [ ] Arrive at /welcome after an invite acceptance with incomplete profile
- [ ] Fill in first name, last name, and phone → submit
- [ ] Confirm redirect to /calendar
- [ ] Confirm profile.first_name and profile.last_name are set

### 25D-18: Welcome form saves when phone is left blank

- [ ] Fill in first name and last name only (phone left empty)
- [ ] Submit → confirm saves correctly, redirect to /calendar

### 25D-19: Welcome form — no hard gate on incomplete profile

- [ ] After invite acceptance with incomplete profile, /welcome is shown
- [ ] While on /welcome, navigate directly to /calendar in the address bar
- [ ] Confirm /calendar loads (no redirect back — incomplete profile is not a route gate)
- [ ] Confirm /welcome itself redirects to /calendar once first_name and last_name are set

### 25D-20: Welcome form works under migration 0079 column-level grants

- [ ] The profiles table UPDATE grant (post-0079) allows only first_name, last_name, phone
- [ ] Confirm the form submits without a "permission denied" error
- [ ] Confirm profile is updated correctly

---

## Sign-Up Without an Invite

### 25D-21: /sign-up with no redirect redirects to /sign-in

- [ ] Navigate to `/sign-up` without a redirect param
- [ ] Confirm redirect to /sign-in
- [ ] Confirm no "Create account" form is shown

### 25D-22: /sign-up with non-invite redirect redirects to /sign-in

- [ ] Navigate to `/sign-up?redirect=/calendar`
- [ ] Confirm redirect to /sign-in (only /join/<code> is permitted)

---

## Pending-Invite Fallback

### 25D-23: Pending-invite shows signed-in email

- [ ] Sign in as a user with no club and no pending invite cookie
- [ ] Navigate to the app (which redirects to /pending-invite)
- [ ] Confirm the signed-in email address is displayed on the page
- [ ] Confirm the copy explains that an invitation link is needed

### 25D-24: Pending-invite sign-out button works

- [ ] On /pending-invite, click "Sign out and use a different account"
- [ ] Confirm redirect to /sign-in after sign-out

### 25D-25: No manual code entry on pending-invite

- [ ] Confirm there is no text input or form for entering an invitation code
- [ ] Confirm the page does not ask the user to paste anything

### 25D-26: App with valid invite cookie redirects to join page (not pending-invite)

- [ ] Open `/join/<code>` while signed out (middleware sets cookie)
- [ ] Sign in at `/sign-in?redirect=/join/<code>` BUT interrupt before invite accepts
      (simulate by using an account that errors, then navigate to /calendar directly)
- [ ] If the cookie is still valid, confirm the app layout redirects to `/join/<code>`
      rather than to /pending-invite

---

## Invalid Invitation States

### 25D-27: Invalid invite — not found

- [ ] Navigate to `/join/00000000000000000000000000000000` (all zeros, nonexistent)
- [ ] Confirm heading "Invitation not found"
- [ ] Confirm message explains the link is not valid and to contact the club

### 25D-28: Expired invite

- [ ] Use an invite whose expires_at is in the past
- [ ] Confirm heading "Invitation expired"
- [ ] Confirm message suggests requesting a new link

### 25D-29: Revoked invite

- [ ] Use an invite that has been revoked
- [ ] Confirm heading "Invitation withdrawn"
- [ ] Confirm message says the invitation was withdrawn and to contact the administrator

### 25D-30: Used invite — signed out

- [ ] Use an invite code that has already been accepted
- [ ] While signed out, navigate to `/join/<code>`
- [ ] Confirm heading "Invitation already accepted"
- [ ] Confirm "Sign in to your account" button is shown
- [ ] Click it → confirm redirect to /sign-in

### 25D-31: Used invite — signed in with a club

- [ ] While signed in as a user who belongs to a club, navigate to a used invite link
- [ ] Confirm "Invitation already accepted" heading
- [ ] Confirm "Go to your account" button is shown
- [ ] Click it → confirm redirect to /calendar

### 25D-31B: Used invite — signed in without a club

- [ ] While signed in as a user with no club (club_id is null), navigate to a used invite link
- [ ] Confirm "Invitation already accepted" heading
- [ ] Confirm "View your account" button is shown (not "Go to your account")
- [ ] Click it → confirm redirect to /pending-invite

---

## Email Mismatch

### 25D-32: Email mismatch shows signed-in email and sign-out option

- [ ] Open a valid email-restricted invite for address A
- [ ] Sign in as account with address B (different address)
- [ ] Open `/join/<code>` → click "Accept Invitation"
- [ ] Confirm the Accept button disappears
- [ ] Confirm the signed-in email (address B) is displayed in the error notice
- [ ] Confirm the message explains the invitation belongs to a different account
- [ ] Confirm "Sign out and use a different account" button appears

### 25D-33: Email mismatch sign-out button works and preserves invitation

- [ ] Click "Sign out and use a different account"
- [ ] Confirm redirect to `/sign-in?redirect=/join/<code>` (the original invite code is preserved)
- [ ] Sign in with the correct account → confirm invite is accepted automatically

### 25D-34: Invite email address is never revealed

- [ ] On the email_mismatch error, confirm address A (the invite's email) is NOT shown
- [ ] Only address B (the signed-in user's email) is shown

---

## Already Belongs to a Club

### 25D-35: Already-in-club state shows current club and calendar link

- [ ] Sign in as a user who already belongs to a club
- [ ] Open a valid invite link for the same or a different club
- [ ] Confirm heading "Already connected"
- [ ] Confirm message shows the user's current club name
- [ ] Confirm "Go to your account" calendar link is shown

### 25D-36: Already-in-club does not change club assignment

- [ ] After viewing the already-connected page, confirm profile.club_id is unchanged
- [ ] Confirm club assignment was not altered

---

## Duplicate Submission

### 25D-37: Accept button prevents double submission

- [ ] Click "Accept Invitation" — confirm button is immediately disabled
- [ ] Attempt to click again while "Accepting…" — confirm no second request is sent
- [ ] After success, navigation happens automatically

---

## Mobile Layout

### 25D-38: Join page readable at 390px

- [ ] Open `/join/<code>` on a 390px viewport (signed out)
- [ ] Confirm both "Sign in to accept" and "Create account" buttons are full-width
- [ ] Confirm no horizontal overflow
- [ ] Confirm email-restricted notice is legible

### 25D-39: Accept button and email-mismatch notice at 390px

- [ ] Trigger email_mismatch on a 390px viewport
- [ ] Confirm the amber notice and sign-out button are readable without overflow

### 25D-40: Pending-invite page at 390px

- [ ] View /pending-invite on mobile
- [ ] Confirm email address is visible and the sign-out button is tappable

---

## Dark Mode

### 25D-41: Join page error states in dark mode

- [ ] Enable dark mode
- [ ] View each error state (not_found, expired, used, revoked)
- [ ] Confirm headings and body text are readable

### 25D-42: Email mismatch amber notice in dark mode

- [ ] Trigger email_mismatch in dark mode
- [ ] Confirm the amber background and text are readable

### 25D-43: Pending-invite in dark mode

- [ ] View /pending-invite in dark mode
- [ ] Confirm all text and buttons are readable

---

## No-Club RLS / Access Regression

### 25D-44: No-club user cannot access club data routes

- [ ] Sign in as a user with club_id = null
- [ ] Navigate directly to /calendar, /events, /admin/members, etc.
- [ ] Confirm redirect to /pending-invite (or /join/<code> if cookie present)
- [ ] Confirm no club data is leaked in responses

### 25D-45: No-club user cannot call club-scoped RPCs

- [ ] As a no-club user, attempt to call get_members() or get_events()
- [ ] Confirm RPC returns no data (RLS/no_club error)

---

## Existing Member Sign-In Regression

### 25D-46: Existing member signs in — goes to calendar

- [ ] Sign out, sign in as a full member (has club, has name)
- [ ] Confirm redirect to /calendar
- [ ] Confirm no invite flow is triggered
- [ ] Confirm no redirect to /welcome

### 25D-47: Existing member profile data unchanged after sign-in

- [ ] After sign-in, confirm profile.first_name, last_name, club_id, role are unchanged

---

## Phase 24 Bookings and Lessons Regression

### 25D-48: Member Bookings tab loads correctly

- [ ] Sign in as a member → navigate to /my-schedule
- [ ] Confirm Upcoming, Lesson Requests, and Past tabs load

### 25D-49: Pro Lessons tab loads correctly

- [ ] Sign in as a Pro → navigate to /admin/lessons
- [ ] Confirm Pro lesson queue loads

### 25D-50: Admin Lessons tab loads correctly

- [ ] Sign in as an Admin → navigate to /admin/lessons
- [ ] Confirm admin lesson management loads

### 25D-51: Admin Bookings destination works

- [ ] Sign in as Admin → click Bookings in SideNav
- [ ] Confirm redirect to /my-schedule
- [ ] Confirm Bookings link is highlighted
