# Phase 22B QA Checklist — Simple Club & Member Onboarding

Branch: `onboarding-tools`
Migration to apply before QA: `0067_add_and_invite.sql`

---

## 1. Pending invitation management

### 1A — Revoke with confirmation
- [ ] Navigate to Admin → Members, find a pending invite
- [ ] Click **Revoke** — inline confirmation appears ("Revoke? Cancel / Yes, revoke")
- [ ] Click **Cancel** — confirmation dismisses, invite unchanged
- [ ] Click **Revoke** again, then **Yes, revoke** — invite disappears from the list

### 1B — Expired invite display
- [ ] Create an invite in the DB or set expires_at to a past timestamp
- [ ] Open Admin → Members — expired invite shows **Expired** badge (amber), no "Copy Link" or "Revoke"
- [ ] Expired invite shows **Generate new link** button (not "Resend")

### 1C — Generate new link (replaces "Resend")
- [ ] Click **Generate new link** on an expired invite
- [ ] Inline confirmation appears: "The expired link stays unusable. A new 7-day link will be generated — copy and share it manually."
- [ ] **Cancel** dismisses confirmation, invite unchanged
- [ ] **Generate link** → page refreshes, expired invite replaced by a new active invite
- [ ] No button or copy uses the word "Resend" anywhere

### 1D — Copy link (active invite)
- [ ] Click **Copy Link** on an active invite — "Copied!" appears briefly
- [ ] Pasted URL is in format `https://<host>/join/<32-hex-code>`

---

## 2. Single-member invite — Add Member unified flow

The **+ Add Member** button is the primary single-member onboarding entry point.
There is no standalone "Generate Invite" button in the action row.

### 2A — Mode selector is first step
- [ ] Click **+ Add Member** → AddMemberSheet opens with title "Add Member"
- [ ] First screen shows two choices: **Add to roster only** and **Add and generate invite**
- [ ] Each choice has a description; no form is shown yet
- [ ] ← back button and sheet × both close the sheet from mode selection

### 2B — Add to roster only
- [ ] Choose **Add to roster only** → form opens (title stays "Add Member")
- [ ] Fields: first name, last name, email (optional), phone (optional), role (Member/Pro/Admin), notes
- [ ] First name and last name are required — server returns error if either is blank
- [ ] Submit with valid data → "Added [Name] to the roster." success screen
- [ ] **Add Another** returns to mode selector; **Done** closes sheet and refreshes list
- [ ] Added member appears on the members list as "No account yet"

### 2C — Email format validated inline (roster mode)
- [ ] In roster mode, enter a malformed email (e.g. "not@valid") and tab out → inline error "Enter a valid email address." appears immediately
- [ ] Clearing the email field → error disappears (email is optional)
- [ ] Form cannot be submitted while email error is visible

### 2D — Add and generate invite
- [ ] Choose **Add and generate invite** → form opens (title "Add and Invite")
- [ ] Fields: first name (required), last name (required), email (required), phone (optional), role (Member/Pro only — no Admin option), notes (optional)
- [ ] Email field has no "(optional)" label
- [ ] Submit with first name, last name, and valid email → "Invite Link Ready" success screen
- [ ] Success shows: "[Name] added to the roster. Invite link ready — valid for 7 days."
- [ ] Invite URL appears in a read-only field with a **Copy** button
- [ ] Copy button shows "Copied!" briefly after click
- [ ] A note reads: "Court Time did not send an email. Copy and share this link manually."
- [ ] **Add Another** returns to mode selector; **Done** closes sheet and refreshes

### 2E — Email required in invite mode
- [ ] In invite mode, attempt to submit with empty email → error "Email is required." shown inline
- [ ] Malformed email (e.g. "notanemail") on blur or submit → "Enter a valid email address."
- [ ] Invalid email blocks submission; no RPC called

### 2F — Duplicate rejection (invite mode)
- [ ] Attempt to add a member whose email already belongs to a club member → "This email already belongs to an active club member."
- [ ] Attempt to add a member whose email is already on the roster → "This email is already on the roster."
- [ ] Attempt to add a member whose email already has an active pending invite → "An active invite already exists for this email."
- [ ] All rejections shown inline; no roster member or invite created

### 2G — InviteSheet for existing roster members
- [ ] Find an existing roster member card that has an email address — it shows a **Send Invite** button
- [ ] Click **Send Invite** → InviteSheet opens titled "Send Invite", email pre-filled from the roster entry
- [ ] Select role, optionally clear or change email, select expiry → click **Generate Link**
- [ ] Invite URL shown with **Copy** button; "Copied!" feedback on copy
- [ ] Invite appears in the Pending Invites section

### 2H — InviteSheet email validation
- [ ] In InviteSheet, change the email field to "notanemail" → click **Generate Link**
- [ ] Error "Enter a valid email address." shown, no RPC called
- [ ] Correct the email → **Generate Link** succeeds

---

## 3. Bulk import — mode selector

### 3A — Mode choice is first step
- [ ] Open Admin → Members → **Import Spreadsheet**
- [ ] First screen shows "Import Members" with two choices: **Add to roster only** and **Generate member invite links**
- [ ] Each choice has a description; no import begins yet

### 3B — Back navigation from mode step
- [ ] Choose a mode, then click ← — returns to mode selector

---

## 4. Bulk import — roster mode (add to roster only)

### 4A — Template download
- [ ] Choose "Add to roster only" → Step 1 shows "Download template CSV"
- [ ] Downloaded file has columns: first_name, last_name, email, phone, notes

### 4B — File upload
- [ ] Upload a valid roster CSV → preview step shows rows with Ready/Warning/Error badges

### 4C — Paste CSV (roster mode)
- [ ] Paste valid CSV in textarea, click Preview → same preview/import/summary flow

### 4D — Validation (roster mode)
- [ ] Row with missing first_name → Error badge, skipped on import
- [ ] Row with email matching existing roster member → Warning badge
- [ ] Duplicate email within batch → Warning badge

### 4E — Import and summary
- [ ] Import button shows count of ready rows
- [ ] After import: "Import complete" summary with added/skipped counts

---

## 5. Bulk import — invite mode (generate member invite links)

### 5A — Template download
- [ ] Choose "Generate member invite links" → Step 1 shows template with columns: first_name, last_name, email, role
- [ ] Downloaded file has those four columns with example rows (member and pro)

### 5B — Email required
- [ ] Upload CSV with a row missing email → that row shows **Invalid** badge
- [ ] Upload CSV with a row with malformed email → **Invalid** badge

### 5C — Row classification
- [ ] Row with email already belonging to a club member → **Already a member** badge, skipped
- [ ] Row with email already on the roster → **On roster** badge, skipped
- [ ] Row with email that already has an active pending invite → **Invite pending** badge, skipped
- [ ] Duplicate email within the import batch → **Duplicate** badge, skipped
- [ ] Valid row with valid email → **Ready** badge

### 5D — Role handling
- [ ] "admin" in role column → **Invalid** badge, row skipped (no demotion, no invite created)
- [ ] "pro" in role column produces a pro invite link
- [ ] Missing role column or blank role defaults to "member"

### 5E — Preview summary
- [ ] Preview shows count of ready vs. skipped rows
- [ ] Note visible: "Only Ready rows will receive invite links. All other rows will be skipped."

### 5F — Generating links
- [ ] Click "Generate N Links" → "Generating invite links…" spinner
- [ ] Results appear: each ready row shows name, email, role, and a copyable invite URL

### 5G — Copy individual links
- [ ] Click **Copy** on any result row → URL copied, button shows "Copied!" briefly
- [ ] URL format: `https://<host>/join/<32-hex-code>`
- [ ] Page does NOT claim email was sent

### 5H — Download CSV
- [ ] Click **Download CSV** button on results summary
- [ ] Downloaded file columns: name, email, role, invite_url
- [ ] Only rows that successfully got invite codes appear; failed rows omitted

### 5I — Failed rows
- [ ] If a row fails to generate (e.g. RPC error) → error message shown inline instead of URL
- [ ] Summary banner shows partial count: "Generated N of M links. X failed."

### 5J — Paste CSV (invite mode)
- [ ] Use paste textarea in invite upload step with valid CSV → preview works the same
- [ ] Both file and paste paths share same parser and preview

### 5K — Mobile usable
- [ ] Mode selector, upload, preview, and results all render usably on a small screen
- [ ] No horizontal overflow on the preview table on mobile (table scrolls horizontally)

---

## 6. Invite code preservation through sign-up

A member who arrived via `/join/<code>` must never need to paste that code again.
The middleware sets a `ct_invite_pending` HttpOnly cookie when `/join/<code>` is opened.

### 6A — Email confirmation flow (Supabase confirms emails)
- [ ] Admin creates a member with "Add and generate invite" or bulk invite → copies the invite link
- [ ] Open link as a signed-out user → see "You're invited" page with club name and role
- [ ] Verify that opening `/join/<code>` sets `ct_invite_pending` cookie (DevTools → Application → Cookies)
- [ ] Cookie is HttpOnly, Secure (production), SameSite=Lax, expires ~1 hour
- [ ] Click **Create account** → redirected to `/sign-up?redirect=/join/<code>`
- [ ] Fill email (matching the email-restricted invite), password, confirm → submit
- [ ] Sign-up page shows "Check your email" — confirmation email sent
- [ ] Click confirmation link in email → `/auth/confirm` exchanges PKCE code, auto-accepts invite
- [ ] **If roster member had first and last name**: redirected to `/calendar` directly — `/welcome` is NOT shown
- [ ] **If no roster name**: redirected to `/welcome` to collect name, then → `/calendar`
- [ ] `ct_invite_pending` cookie is cleared after acceptance
- [ ] No step asks the member to paste the invite code again

### 6B — Email confirmation — cookie fallback (email client strips query params)
- [ ] If the `next` param is stripped from the confirmation URL (simulate by visiting `/auth/confirm?code=<pkce>` without `&next=`):
  - `/auth/confirm` falls back to the `ct_invite_pending` cookie
  - Invite is accepted and user is redirected to `/calendar` or `/welcome`
  - **Not** redirected to `/sign-in?error=invalid_redirect`

### 6C — Immediate session flow (Supabase does not require email confirmation)
- [ ] Open invite link → "You're invited" page → click **Create account**
- [ ] Fill form → submit → Supabase returns session immediately
- [ ] SignUpForm auto-accepts the invite without any further user action — no "Accept Invitation" button to click
- [ ] **If roster member had first and last name**: redirected directly to `/calendar`
- [ ] **If no roster name**: redirected to `/welcome`, then → `/calendar`
- [ ] Page never shows `/join/<code>` with an Accept button
- [ ] Page never redirects to `/pending-invite`
- [ ] If acceptance fails (email mismatch, invite expired, invite used): error shown inline on the sign-up form
- [ ] `ct_invite_pending` cookie is cleared after acceptance or definitive failure

### 6D — Sign-in flow (member already has an account)
- [ ] Open invite link → cookie set → click **Sign in to accept** → `/sign-in?redirect=/join/<code>`
- [ ] Sign in → SignInForm auto-accepts using the code extracted from the redirect param
- [ ] No "Accept Invitation" button shown — user goes directly to `/calendar` or `/welcome`
- [ ] `ct_invite_pending` cookie is cleared after acceptance

### 6E — Cookie fallback for sign-in without redirect param
- [ ] Open invite link → cookie set → navigate to `/sign-in` directly (without `?redirect=`)
- [ ] Sign in → SignInForm calls `acceptPendingInviteAction(undefined)` → reads cookie → auto-accepts
- [ ] User goes directly to `/calendar` or `/welcome` — no `/pending-invite`

---

## 7. Roster claiming and automatic profile population

After invite acceptance, if the member's email matches an unclaimed roster entry:

### 7A — Roster auto-claim
- [ ] Admin adds a roster member with first name, last name, email, phone; creates invite for that email
- [ ] Member signs up, accepts invite → check DB: `roster_members.claimed_by = member's user_id`
- [ ] `audit_log` contains a `claim_roster_member` entry for this acceptance

### 7B — Name and phone copied to profile
- [ ] After acceptance, `profiles.first_name` = the roster entry's first name (was blank before)
- [ ] `profiles.last_name` = the roster entry's last name (was blank before)
- [ ] `profiles.phone` = the roster entry's phone (was blank before)
- [ ] Member is redirected to `/calendar` directly — `/welcome` is NOT shown

### 7C — Profile data is never overwritten, including blank strings
- [ ] If member had already set their own name (e.g. via /welcome), the existing value is kept
- [ ] Roster `first_name` and `last_name` are copied when profile fields are NULL **or blank** (empty string or whitespace only)
- [ ] Whitespace-only profile fields (e.g. `" "`) are treated as blank and replaced by roster data

### 7D — /welcome shown only when names are missing
- [ ] Accept an invite that has no matching roster entry → `/welcome` shown (names unknown)
- [ ] Complete `/welcome` form → redirected to `/calendar`
- [ ] Accept an invite that has a matching roster entry with names → `/welcome` is skipped entirely

---

## 8. /pending-invite fallback (non-interactive, authorized fallback only)

`/pending-invite` is the last-resort page for an authenticated account with no club
and no preserved invite context. It must NOT appear during a normal invite flow.

### 8A — Page is non-interactive
- [ ] Navigate to `/pending-invite` → page shows heading and two actions only (no form, no input)
- [ ] Heading: "Account not connected"
- [ ] Body explains the account is not connected to a club and to reopen the invite link or ask for a new one
- [ ] **Sign out** button is present
- [ ] **Return to sign in** link is present
- [ ] No text input, no paste field, no "Continue" button

### 8B — Sign out action works
- [ ] Click **Sign out** → signed out → navigated to `/sign-in`
- [ ] Attempting to visit an app route after sign out → redirected to `/sign-in`

### 8C — Normal invite flows never hit /pending-invite
- [ ] Email-confirmation signup flow → never redirected to /pending-invite
- [ ] Immediate-session signup flow → never redirected to /pending-invite
- [ ] Sign-in with `?redirect=/join/<code>` → never redirected to /pending-invite
- [ ] Sign-in without redirect param but with cookie → auto-accepts → never redirected to /pending-invite

### 8D — Cookie fallback in layout guard
- [ ] Open invite link as logged-in user (has session, but the account has no club)
- [ ] Navigate to any app route (e.g. `/calendar`) → layout reads cookie → redirected to `/join/<code>`
- [ ] Accept → club assigned → app route accessible

### 8E — /pending-invite shown only with no cookie and no club
- [ ] Create a fresh Supabase Auth user with no club (no invite used, no cookie) → sign in → redirected to /pending-invite
- [ ] Navigating to `/calendar` or any app route → /pending-invite (no cookie to redirect)

### 8F — /join/[code] error states (regression)
- [ ] Visit `/join/<invalid-code>` → "Invite not found"
- [ ] Visit `/join/<expired-code>` → "Invite expired. Ask your admin for a new link."
- [ ] Visit `/join/<revoked-code>` → "Invite revoked."
- [ ] Visit `/join/<used-code>` when already a member → "Already a member"

---

## 9. First-sign-in orientation card

### 9A — Card location
- [ ] Sign in as a new member → welcome card appears in the app layout (above page content)
- [ ] Card appears on any first page reached: /calendar, /events, /my-schedule, etc.
- [ ] Card does NOT appear on /events specifically — it appears above it in the layout

### 9B — Card content
- [ ] Card heading: "Welcome to the club!"
- [ ] Four bullets present:
  - **Calendar** — Find and reserve courts
  - **Events** — Join club activities and scheduled sessions
  - **Bookings** — View your reservations and event history
  - **Account** — Update your profile, notifications, and get help

### 9C — Dismiss
- [ ] Click × button — card disappears immediately
- [ ] Refresh page — card does not reappear (localStorage set)
- [ ] Navigate to a different page — card remains dismissed

### 9D — User + club scoped key
- [ ] Check localStorage: key is `ct_welcome_<userId>_<clubId>` (not global `ct_welcome_dismissed`)
- [ ] If two members on the same browser, each sees the card independently

### 9E — No SSR flash
- [ ] Hard refresh as a member who has dismissed the card — card does not flash visible then disappear

### 9F — Admin and pro do not see card
- [ ] Sign in as admin → no welcome card anywhere in the layout
- [ ] Sign in as pro → no welcome card anywhere in the layout

---

## 10. Admin Overview setup checklist

### 10A — All 9 items present (admin only)
- [ ] Navigate to Admin → Overview → "Setup checklist" section visible (admin only)
- [ ] Exactly 9 rows: Club name, Timezone, Active court, Operating hours, Active event type, Additional admin or pro, Members, Email delivery (optional), SMS delivery (optional)
- [ ] "Email delivery" and "SMS delivery" rows are labeled **(optional)**

### 10B — Required checks: correct Done conditions
- [ ] Club name set → "Club name" shows Done
- [ ] Timezone set → "Timezone" shows Done
- [ ] At least one active court → "Active court" shows Done
- [ ] At least one operating_hours row with is_closed = false → "Operating hours" shows Done
- [ ] At least one active event type → "Active event type" shows Done
- [ ] At least one active profile with role admin or pro that is NOT the current admin → "Additional admin or pro" shows Done
- [ ] At least one of: active member (excluding self), roster member, or pending active invite → "Members" shows Done

### 10C — Members check excludes current admin
- [ ] Admin with no other members, no roster, no invites → "Members" shows "Set up →"
- [ ] Invite sent (active, not expired) → "Members" shows Done
- [ ] Roster member added → "Members" shows Done

### 10D — Additional admin/pro excludes self
- [ ] Only current admin exists as admin/pro → "Additional admin or pro" shows "Set up →"
- [ ] Another admin or pro added → "Additional admin or pro" shows Done

### 10E — Operating hours check
- [ ] No operating hours set (all is_closed=true or no rows) → "Operating hours" shows "Set up →"
- [ ] At least one day set with is_closed=false → "Operating hours" shows Done

### 10F — Links correct
- [ ] "Club name" → /admin/settings
- [ ] "Timezone" → /admin/settings
- [ ] "Active court" → /admin/courts
- [ ] "Operating hours" → /admin/settings
- [ ] "Active event type" → /admin/settings
- [ ] "Additional admin or pro" → /admin/members
- [ ] "Members" → /admin/members
- [ ] "Email delivery" → /admin/settings
- [ ] "SMS delivery" → /admin/settings

### 10G — Pro users do not see checklist
- [ ] Sign in as pro → Admin → Overview → no "Setup checklist" section visible

---

## 11. Security spot-checks

- [ ] `addRosterMemberAndInviteAction`: call without authentication → returns "You must be signed in."
- [ ] `addRosterMemberAndInviteAction`: call as member (not admin) → returns "Only admins can manage members."
- [ ] `add_roster_member_and_invite` RPC: role = "admin" → raises `invalid_role`, no roster member or invite created
- [ ] `add_roster_member_and_invite` RPC: invalid email "notanemail" → raises `invalid_email_format`, no rows created
- [ ] `add_roster_member_and_invite` RPC: not callable by anon role — `EXECUTE revoked from anon` (verify in SQL: `SELECT has_function_privilege('anon', 'public.add_roster_member_and_invite(text,text,text,text,text,text)', 'EXECUTE')` → `f`)
- [ ] `accept_club_invite` RPC: not callable by anon role — verify same way (expect `f` for anon)
- [ ] `add_roster_member_and_invite`: invite `expires_at` in DB is always `now() + 7 days`, regardless of when the action is called — callers cannot supply a custom expiry
- [ ] `add_roster_member_and_invite`: two simultaneous requests for the same club + email — only one roster entry and one invite created; second request receives a duplicate-check error
- [ ] `resendInviteAction` (now "Generate new link"): call without authentication → returns "You must be signed in."
- [ ] `importInvitesAction`: call without authentication → returns "You must be signed in."
- [ ] `importInvitesAction`: call as member → returns "Only admins can manage members."
- [ ] `importInvitesAction`: "admin" role in CSV classified Invalid at parse time — row skipped, no invite created
- [ ] Paste CSV textarea: pasting JS/HTML → treated as raw text, no XSS (no innerHTML used)
- [ ] `ct_invite_pending` cookie: HttpOnly (not readable by JS), Secure in production, SameSite=Lax
- [ ] `ct_invite_pending` cookie: value is always exactly a 32-char hex code (not logged, not echoed in responses)
- [ ] `ct_invite_pending` cookie: cleared after successful acceptance
- [ ] `ct_invite_pending` cookie: cleared after definitive failure (invalid, expired, revoked, used, email_mismatch)
- [ ] `ct_invite_pending` cookie: NOT cleared on `not_authenticated` (user may authenticate later)
- [ ] Middleware only sets cookie on `/join/<32-hex>` paths — arbitrary paths do not set the cookie
- [ ] Admin overview setup queries: pro user sees no setup checklist

---

## 12. Regression

- [ ] InviteSheet (reached via **Send Invite** on a roster card): generate + copy link still works normally
- [ ] AddMemberSheet **Add to roster only** mode works end-to-end
- [ ] File-upload CSV roster import still works end-to-end (upload → preview → import → summary)
- [ ] Member status toggle (deactivate/reactivate) still requires confirmation dialog
- [ ] Roster member delete still requires confirmation dialog
- [ ] /join/[code] sign-in flow and auto-accept on /auth/confirm still work
- [ ] /welcome profile completion still redirects to /calendar
- [ ] pnpm build exits 0 with no new type errors
