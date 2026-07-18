# Phase 22 Closeout — QA Record and Merge Authorization

**Date:** 2026-07-18
**Branch at closeout:** `phase-22-closeout`
**Operator:** tmont001

> **STATUS: ONE SECURITY-HARDENING BLOCKER PENDING**
> Migration 0068 (`0068_harden_phase22_function_search_path.sql`) has been
> created but not yet applied.  Phase 22 is not fully closed until 0068 is
> applied to the cloud environment and verified.  See sections 2, 3, and 13.

---

## 1. Phase 22 Scope Summary

### Phase 22A — Club Configuration
- Admin-managed club timezone via `update_club_timezone` RPC
- Admin-managed event types: create, rename, recolor, deactivate, delete
- `member_joinable` toggle for future events (admin and pro writers)
- Migration: 0064, 0065, 0066
- **Security gap found in Phase 22D closeout:** 0064–0066 functions were defined
  without a fixed `search_path`.  Hardened by migration 0068 (see section 2).

### Phase 22B — Member Onboarding and Invite Security
- `add_roster_member_and_invite` unified RPC: atomically creates roster entry +
  email-restricted invite with hardcoded 7-day expiry, advisory lock, server-side
  email format validation, duplicate checks, full audit trail
- `accept_club_invite` updated: blank-aware name copy from roster entry into profile
  (`btrim(coalesce(field, '')) = ''` pattern); copies first_name, last_name, phone
- `ct_invite_pending` cookie: HttpOnly, Secure (prod-only), SameSite=Lax, 1h TTL,
  path=/ — set by root middleware on every `/join/<code>` visit
- Root `middleware.ts` is canonical; `src/middleware.ts` deleted (was shadowing root)
- `/auth/confirm` auto-accepts pending invite after email-confirm code exchange
- `/pending-invite` non-interactive: single sign-out button only
- AddMemberSheet two-mode selector: roster-only vs add-and-invite
- ImportMembersSheet: CSV upload with roster-only or add-and-invite mode
- InviteSheet: email validation, "Generate new link" replaces "Resend", 7-day expiry
- Migration: 0067

### Phase 21L Recovery — Pilot Sales Readiness
- Public marketing route group: `/`, `/pricing`, `/contact`, `/terms`, `/privacy`
- Marketing layout, nav (`MarketingNav`), footer (`MarketingFooter`), reveal animation
- Homepage: `if (user) redirect('/calendar')` guard preserved
- Pricing: $149/month · $1,490/year (verified accurate)
- `MemberWelcomeCard` component for onboarding completion UX
- QA record: `QA_phase21L_recovered.md` with header note; findings appended to
  `QA_phase21.md` Phase 21L Recovery section

### Phase 22C — Performance and Navigation
- `src/lib/supabase/user.ts`: `getAuthUser()` + `getAuthProfile()` via `React.cache()`
  — per-request memoization, never cross-user, never cross-request
- `getAuthProfile` selects a superset of all columns consumed by any page or layout
  (`id, club_id, role, status, first_name, last_name, phone`) so all callers share
  one network call regardless of how many layouts/pages are rendered in the same request
- 14 pages/layouts migrated from independent `createClient()` + auth/profile calls to
  the shared helpers
- `my-schedule/page.tsx`: 4 downstream queries consolidated into one `Promise.all`
  (was: club+settings in batch 1, reservations+signups in batch 2)
- `src/app/(app)/admin/loading.tsx`: admin-specific loading skeleton (header, card rows)
- No migrations. No UI redesign. No weakening of auth, RLS, role checks, or isolation.

---

## 2. Migration Inventory (0064–0068)

> **Security gap discovered in Phase 22D closeout:**
> Migrations 0064, 0065, and 0066 defined SECURITY DEFINER functions using
> `language plpgsql security definer as $$` without a `SET search_path` clause.
> Without a fixed search_path a SECURITY DEFINER function resolves names against
> the caller's search_path at call time, which an attacker or misconfigured caller
> could manipulate to shadow public schema objects.
> Migration 0067 already had the correct setting.
> Migration 0068 retroactively hardens all seven affected functions from 0064–0066,
> and re-applies the setting to the two 0067 functions as defense-in-depth.

### 0064 — `update_club_timezone`

| Property | Value |
|---|---|
| SECURITY DEFINER | yes |
| search_path (as deployed) | **not set — hardened by 0068** |
| REVOKE from public/anon | yes |
| GRANT to authenticated | yes |
| Role check | admin only |
| Input validation | explicit NULL check + IANA allowlist (7 US zones) |
| Audit trail | yes — `update_club_timezone` action in `audit_log` |
| Re-run safety | fully idempotent (CREATE OR REPLACE + REVOKE/GRANT) |
| Schema changes | none |

### 0065 — Event type management

| Property | Value |
|---|---|
| Schema changes | DROP CONSTRAINT (key_check); ADD COLUMN `is_active boolean not null default true` |
| New RPCs | `create_event_type`, `update_event_type`, `set_event_type_active` |
| New trigger function | `check_event_type_active` (BEFORE INSERT or UPDATE OF event_type_id) |
| SECURITY DEFINER | all three RPCs + trigger function |
| search_path (as deployed) | **not set on any — hardened by 0068** |
| REVOKE/GRANT | yes on all three RPCs; not applicable to trigger function (invoked by engine) |
| Role check | admin only (RPCs); trigger enforces active-type constraint regardless of caller |
| Input validation | explicit NULL checks; label blank check; color hex regex |
| Audit trail | yes on all three RPCs |
| Defense-in-depth | RLS INSERT + UPDATE policies for `event_types` |
| Re-run safety | DROP POLICY/TRIGGER IF EXISTS + CREATE OR REPLACE + REVOKE/GRANT |

### 0066 — `set_event_member_joinable` + `delete_event_type`

| Property | Value |
|---|---|
| SECURITY DEFINER | both functions |
| search_path (as deployed) | **not set — hardened by 0068** |
| REVOKE/GRANT | yes on both |
| Role check | `set_event_member_joinable`: admin or pro (pro scoped to own events); `delete_event_type`: admin only |
| Eligibility guards | not cancelled, not archived, not started (server-side future guard) |
| Delete guards | not a seeded type; not active; not referenced by any event |
| Audit trail | yes on both |
| Re-run safety | fully idempotent |
| Schema changes | none |

### 0067 — `add_roster_member_and_invite` + `accept_club_invite` (updated)

| Property | Value |
|---|---|
| SECURITY DEFINER | both functions |
| search_path (as deployed) | `public, pg_temp` — correct; re-applied by 0068 as defense-in-depth |
| REVOKE/GRANT | yes on both |
| Role check (add) | admin only; club_id derived from profile, never trusted from caller |
| Role validation (add) | only member or pro allowed for invite-linked onboarding |
| Email format (add) | server-side regex `^[^@\s]+@[^@\s]+\.[^\s]+$` |
| Expiry (add) | hardcoded `now() + interval '7 days'`; caller cannot override |
| Advisory lock | `pg_advisory_xact_lock(hashtext(club_id::text || ':' || email)::bigint)` — serializes concurrent duplicate-check + insert |
| Duplicate checks (add) | existing member; unclaimed roster entry; active pending invite |
| Audit trail (add) | `add_roster_member` + `create_invite` actions |
| Accept guards | not authenticated check; already-in-club check; FOR UPDATE lock; revoked/used/expired/email_mismatch checks |
| Name copy (accept) | `btrim(coalesce(field, '')) = ''` — copies only when NULL or blank |
| Re-run safety | fully idempotent (CREATE OR REPLACE + REVOKE/GRANT) |
| Applied | yes — confirmed applied in cloud environment |

### 0068 — `harden_phase22_function_search_path` ⚠ PENDING APPLICATION

| Property | Value |
|---|---|
| What it does | `ALTER FUNCTION ... SET search_path = public, pg_temp` on all 9 Phase 22 SECURITY DEFINER functions |
| Functions hardened | `update_club_timezone`, `create_event_type`, `update_event_type`, `set_event_type_active`, `check_event_type_active`, `set_event_member_joinable`, `delete_event_type`, `add_roster_member_and_invite`, `accept_club_invite` |
| Body changes | none |
| Schema/data changes | none |
| Role/grant changes | none |
| Re-run safety | fully idempotent (`ALTER FUNCTION SET` is always safe to re-apply) |
| Applied | **NO — pending operator application in cloud SQL Editor** |

---

## 3. Automated Validation

All validation run on branch `main` after all Phase 22 sub-branches merged.

```
git diff --check          → exit 0  (no whitespace or conflict markers)
pnpm tsc --noEmit         → exit 0  (0 TypeScript errors)
pnpm build                → exit 0  (BUILD_EXIT=0)
git status --short        → clean   (no uncommitted changes)
```

### Build output (key routes)

| Route | Render mode |
|---|---|
| / | ƒ Dynamic (redirects signed-in users to /calendar) |
| /pricing | ○ Static |
| /contact | ○ Static |
| /terms | ○ Static |
| /privacy | ○ Static |
| /calendar | ƒ Dynamic |
| /events | ƒ Dynamic |
| /my-schedule | ƒ Dynamic |
| /profile | ƒ Dynamic |
| /admin/settings | ƒ Dynamic |
| /join/[code] | ƒ Dynamic |
| /pending-invite | ○ Static |

### Known non-blocking diagnostic

`/sign-up` emits a pre-existing build-time warning:

```
Dynamic server usage: Route /sign-up couldn't be rendered statically
because it used `cookies`.
```

This is pre-existing behavior (Supabase client reads cookies for invite context).
Build exit is 0. Route correctly emits as `ƒ` Dynamic. This is not caused by
Phase 22 changes and is not a blocker.

---

## 4. Phase 22A — Completed Verification

### Admin Settings — Club Timezone

- `ClubTimezoneSection.tsx` renders a dropdown of the 7 US IANA zones
- Calls `update_club_timezone` RPC; handles `insufficient_role` and `invalid_timezone`
- `actions.ts` server action wraps RPC call and calls `revalidatePath('/admin/settings')`
- Timezone is displayed in Admin Settings page; used in calendar and event display

### Admin Settings — Event Types

- `EventTypesSection.tsx` renders existing types with edit (pencil) and active toggle
- Create type button opens inline form; calls `create_event_type` RPC
- Edit in-place: calls `update_event_type` RPC
- Toggle active/inactive: calls `set_event_type_active` RPC
- Delete (inactive, unreferenced, non-seeded only): calls `delete_event_type` RPC
- Seeded types (lesson, clinic, social, league, tournament) cannot be deleted
- `CreateEventSheet` filters `is_active = true` when listing event type options

### Admin Events — member_joinable Toggle

- Future events in admin events view have a toggle for member-joinable
- Pro sees only own future events; admin sees all club future events
- `set_event_member_joinable` RPC enforces: not cancelled, not archived, not started
- Toggle written to `events.member_joinable`; members see only member_joinable events

---

## 5. Phase 22B — Completed Verification

### Root Middleware

- Root `middleware.ts` calls `updateSession(request)` then sets `ct_invite_pending`
  cookie when path matches `/join/<hex32>`
- `src/middleware.ts` does not exist (deleted in Phase 22B to resolve shadowing)
- Cookie attributes: `httpOnly: true`, `secure: NODE_ENV === 'production'`,
  `sameSite: 'lax'`, `maxAge: 3600`, `path: '/'`

### invite/accept flows

- `/join/[code]`: calls `acceptInviteAction(code)` which clears cookie on success or
  definitive error; redirects to `/calendar` or `/welcome` based on profile completeness
- `/auth/confirm`: exchanges email-confirm code; resolves invite from `next` param or
  cookie fallback; calls `accept_club_invite` RPC; redirects to `/calendar` or `/welcome`
- `/sign-in` and `/sign-up`: call `acceptPendingInviteAction()` after session established
- `destAfterAccept(userId)`: trims first_name + last_name; `/welcome` if either is blank

### /pending-invite

- Non-interactive: displays a message only
- Single button: "Sign out and return to sign in"
- Button awaits `supabase.auth.signOut()` then calls `router.push('/sign-in')`
- No code entry form, no redirect loop, no invite from here

### AddMemberSheet / ImportMembersSheet

- Mode selector is first screen: "Add to roster only" vs "Add and generate invite"
- Roster-only: calls `add_roster_member` (existing RPC, no invite)
- Add-and-invite: calls `add_roster_member_and_invite`; displays invite URL with Copy
- Import: CSV upload; same two modes applied per-row
- No invite email sent; operator copies and shares link manually

### InviteSheet (existing roster members)

- Active invite: shows Copy Link button
- Expired invite: shows "Generate new link" (not "Resend"); confirmation before generating
- Revoke: inline confirmation before revoking

---

## 6. Phase 22C — Completed Verification

### React.cache() implementation

- `src/lib/supabase/user.ts`: both helpers use `import { cache } from "react"`
- `getAuthUser` calls `supabase.auth.getUser()` once per request
- `getAuthProfile` calls `getAuthUser()` (memoized) then one `.from("profiles").select(...)`
  with the superset of all columns any caller needs
- `React.cache()` resets between RSC requests — not shared across users or requests
- No `unstable_cache` is used anywhere in the auth path

### Pages and layouts updated

All 14 files confirmed updated:

```
src/app/(app)/layout.tsx
src/app/(app)/admin/layout.tsx
src/app/(app)/admin/audit-log/page.tsx
src/app/(app)/admin/courts/page.tsx
src/app/(app)/admin/members/page.tsx
src/app/(app)/admin/overview/page.tsx
src/app/(app)/admin/settings/page.tsx
src/app/(app)/calendar/page.tsx
src/app/(app)/events/page.tsx
src/app/(app)/help/page.tsx
src/app/(app)/my-schedule/page.tsx
src/app/(app)/profile/page.tsx
src/app/(app)/profile/notifications/page.tsx
src/app/(app)/profile/security/page.tsx
```

### my-schedule parallelization

`my-schedule/page.tsx` consolidates all 4 downstream queries into one `Promise.all`
after `getAuthProfile()` resolves: clubs (timezone), club_settings (cancel window),
reservations, event_participants. Previously: two sequential batches.

### Admin loading skeleton

`src/app/(app)/admin/loading.tsx` provides an admin-specific skeleton (header, back
link placeholder, section heading, card rows with dividers) for all `/admin/*` routes.

---

## 7. Files Changed in Phase 22

### New files

```
middleware.ts                                          (canonical; merged from root)
src/lib/supabase/user.ts                              (React.cache() helpers)
src/app/(app)/admin/loading.tsx                       (admin loading skeleton)
src/app/(app)/admin/settings/ClubTimezoneSection.tsx
src/app/(app)/admin/settings/EventTypesSection.tsx
src/app/(marketing)/layout.tsx
src/app/(marketing)/template.tsx
src/app/(marketing)/page.tsx
src/app/(marketing)/pricing/page.tsx
src/app/(marketing)/contact/page.tsx
src/app/(marketing)/terms/page.tsx
src/app/(marketing)/privacy/page.tsx
src/app/(marketing)/components/MarketingNav.tsx
src/app/(marketing)/components/MarketingFooter.tsx
src/app/(marketing)/components/MarketingReveal.tsx
src/components/MemberWelcomeCard.tsx
supabase/migrations/0064_update_club_timezone_rpc.sql
supabase/migrations/0065_event_type_management.sql
supabase/migrations/0066_set_event_member_joinable.sql
supabase/migrations/0067_add_and_invite.sql
supabase/scripts/QA_phase22a.md
supabase/scripts/QA_phase22b.md
supabase/scripts/QA_phase22c.md
supabase/scripts/QA_phase21L_recovered.md
```

### Deleted files

```
src/app/page.tsx                   (replaced by (marketing)/page.tsx)
src/middleware.ts                  (was shadowing root middleware.ts)
```

### Modified files (key)

```
src/app/(app)/layout.tsx                   (React.cache() helpers; invite cookie redirect)
src/app/(app)/admin/layout.tsx             (React.cache() helpers; removed createClient import)
src/app/(app)/admin/members/actions.ts     (add_roster_member_and_invite, import actions)
src/app/(app)/admin/members/AddMemberSheet.tsx    (mode selector + two-form flows)
src/app/(app)/admin/members/ImportMembersSheet.tsx (CSV upload + mode)
src/app/(app)/admin/members/InviteSheet.tsx        (generate new link, 7-day wording)
src/app/(app)/admin/members/MembersClient.tsx      (revoke confirmation UX)
src/app/(app)/admin/settings/actions.ts    (timezone + event type server actions)
src/app/(app)/admin/settings/page.tsx      (timezone + event types sections)
src/app/(app)/admin/events/actions.ts      (set_event_member_joinable action)
src/app/(app)/my-schedule/page.tsx         (Promise.all parallelization)
src/app/(auth)/join/[code]/actions.ts      (acceptInviteAction, destAfterAccept)
src/app/(auth)/pending-invite/page.tsx     (non-interactive; sign-out only)
src/app/auth/confirm/route.ts              (auto-accept on email confirm)
src/app/(auth)/sign-in/SignInForm.tsx      (acceptPendingInviteAction after sign-in)
src/app/(auth)/sign-up/SignUpForm.tsx      (acceptPendingInviteAction after sign-up)
supabase/scripts/QA_phase21.md             (Phase 21L Recovery section appended)
src/lib/db/types.ts                        (is_active on event_types; invite types)
src/app/globals.css                        (marketing page styles)
src/app/layout.tsx                         (root layout; font and metadata updates)
```

---

## 8. Deferred Work (Phase 22 scope boundary)

The following items were explicitly deferred out of Phase 22. They are NOT blockers.

| Item | Deferred to |
|---|---|
| Waitlist promotion mode toggle (offer-confirm vs auto-promote) | Phase 23+ |
| Per-kind SMS preference column (currently one enabled toggle per kind) | Future profile polish |
| Notification Settings consolidation (/profile vs /profile/notifications) | Future profile polish |
| Waitlist offer confirmation window setting per event | Phase 23+ |
| Sheet UX standardization (InviteSheet etc. → BottomSheet) | Phase 23+ |
| CRM, payment processing, self-serve signup | Phase 25+ |
| International timezone support (non-US IANA identifiers) | Future onboarding |
| Custom invite email (currently copy-and-share only) | Future comms |
| Automated expiry refresh for pending invites | Future admin UX |

---

## 9. Manual Sign-off Checklist

The following items require operator confirmation before treating Phase 22 as fully
QA'd. They cannot be verified by automated build or TypeScript checks.

**Authentication and invites:**
- [ ] Visit `/join/<code>` while signed out → sign-up → invite auto-accepted, redirected to /calendar or /welcome
- [ ] Visit `/join/<code>` while signed out → sign-in → invite auto-accepted
- [ ] Confirm email link (email-confirm flow) → invite auto-accepted via /auth/confirm
- [ ] Visit `/join/<code>` while already signed in with a club → `already_in_club` error shown
- [ ] /pending-invite: only sign-out button visible; no code entry form; sign-out redirects to /sign-in
- [ ] After accepting an invite where admin pre-filled name: profile first_name/last_name populated; /welcome skipped (redirected to /calendar)

**Club admin:**
- [ ] Admin Settings → update timezone → calendar and schedule reflect new timezone after refresh
- [ ] Admin Settings → create new event type → appears in CreateEventSheet type dropdown
- [ ] Admin Settings → deactivate event type → disappears from CreateEventSheet dropdown; historical events unchanged
- [ ] Admin Settings → delete inactive unreferenced custom type → removed; seeded types have no delete option
- [ ] Admin Events → toggle member_joinable on a future event → members see/hide the event accordingly

**Member onboarding:**
- [ ] Admin → Members → + Add Member → Add to roster only → member appears as "No account yet"
- [ ] Admin → Members → + Add Member → Add and generate invite → invite URL shown, "Court Time did not send an email" note present
- [ ] Copy invite link → share to invitee → invitee accepts → roster auto-linked; name populated
- [ ] Expired invite → Generate new link → confirmation shown; new 7-day link created
- [ ] Revoke active invite → inline confirmation → invite gone from list

**Marketing pages:**
- [ ] Logged-out: /, /pricing, /contact, /terms, /privacy all load without sign-in
- [ ] Logged-in: visiting / redirects to /calendar
- [ ] No authenticated app nav (SideNav, BottomNav) visible on marketing pages
- [ ] Pricing shows $149/month · $1,490/year (correct)

**Performance:**
- [ ] Calendar, Events, Bookings, Account navigation: no visible double-auth or double-profile network calls in browser devtools
- [ ] Admin pages show admin-specific loading skeleton during transitions
- [ ] my-schedule loads reservations and events correctly

---

## 10. Known Non-Blockers

| Issue | Status | Reason not a blocker |
|---|---|---|
| /sign-up build warning (Dynamic server usage: cookies) | Pre-existing | Present before Phase 22; build exits 0; route correctly dynamic |
| SMS delivery inactive (Twilio not configured) | Deferred | Email and in-app notifications work; SMS is Phase 16 deferred item |
| No custom invite email (copy-and-share only) | By design | Court Time does not send email; operator shares link manually |
| Notification prefs split across /profile and /profile/notifications | Deferred | Logged as backlog; not a Phase 22 item |

---

## 11. Migration Application Order (cloud)

```
0064_update_club_timezone_rpc.sql       ← APPLIED
0065_event_type_management.sql          ← APPLIED
0066_set_event_member_joinable.sql      ← APPLIED
0067_add_and_invite.sql                 ← APPLIED
0068_harden_phase22_function_search_path.sql  ← PENDING — apply next
```

Migrations 0064–0067 have been applied in the cloud environment (operator-confirmed).
Each migration is fully idempotent and safe to re-apply if needed.

### Applying 0068

Paste the full contents of
`supabase/migrations/0068_harden_phase22_function_search_path.sql`
into the Supabase SQL Editor and run it.  There is no output on success.

### Verifying 0068

After applying, run this SQL in the Supabase SQL Editor to confirm every Phase 22
SECURITY DEFINER function has a fixed search_path:

```sql
select
  p.proname                         as function_name,
  pg_get_function_identity_arguments(p.oid) as signature,
  p.prosecdef                       as security_definer,
  p.proconfig                       as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'update_club_timezone',
    'create_event_type',
    'update_event_type',
    'set_event_type_active',
    'check_event_type_active',
    'set_event_member_joinable',
    'delete_event_type',
    'add_roster_member_and_invite',
    'accept_club_invite'
  )
order by p.proname;
```

Expected: `prosecdef = true` and `config` contains
`search_path=public, pg_temp` for every row.

After verification, update this document:
- Change `0068` status from PENDING to APPLIED.
- Change the blocker status in section 13 from OPEN to NONE.
- Remove the warning banner at the top of this document.

---

## 12. Commit Reference

| Phase | Commit | Message |
|---|---|---|
| 22A | 5e26c5b | Complete Phase 22A club configuration |
| 22B | 52cb4bc | Complete Phase 22B member onboarding |
| 21L recovery | 810d7f2 | Add public pilot sales pages |
| 21L QA | 0f257da | Document recovered Phase 21L sales readiness |
| 22C | beb0167 | Reduce per-request auth/profile duplication and parallelize my-schedule queries |

---

## 13. Go / No-Go

**Automated checks:** PASS
- `git diff --check`: 0
- `pnpm tsc --noEmit`: 0
- `pnpm build`: 0 (BUILD_EXIT=0)
- Working tree: 2 new files (`QA_phase22_closeout.md`, `0068_harden_phase22_function_search_path.sql`)

**Implementation:** COMPLETE
- Phase 22A, 22B, 22C, Phase 21L recovery: all merged to main
- Migrations 0064–0067: applied in cloud
- No partial implementations or in-progress stubs

**Blockers:** ONE OPEN — SECURITY HARDENING

| Blocker | Severity | Resolution |
|---|---|---|
| Migration 0068 not yet applied | Security | Apply `0068_harden_phase22_function_search_path.sql` via Supabase SQL Editor; verify with query in section 11 |

**Recommendation:** Apply migration 0068 and verify using the query in section 11.
After 0068 is applied and verified, complete manual operator sign-off on the checklist
in section 9. Phase 23 may begin after both are done.

---

## 14. Suggested Commit Message for This Document

```
Add Phase 22 closeout QA record and security hardening migration

Authoritative closeout for Phase 22A (club configuration),
22B (member onboarding), Phase 21L recovery (marketing pages),
and 22C (performance and navigation).

Migration 0068 retroactively sets a fixed search_path on all
Phase 22 SECURITY DEFINER functions from migrations 0064–0066
that were deployed without this setting. Migration 0067 functions
are re-hardened as defense-in-depth.

Includes migration inventory, automated validation results,
files-changed summary, deferred item registry, and manual
sign-off checklist.
```

---

## 15. What Phase 23 Should Not Reopen

Phase 23 planning should treat the following as closed:

- The `ct_invite_pending` cookie flow and `/pending-invite` behavior
- The `add_roster_member_and_invite` function signature (6 params; no expiry override)
- The `accept_club_invite` blank-aware name copy logic
- Marketing page content and pricing figures (update via content-only PR if needed)
- The `React.cache()` memoization approach in `src/lib/supabase/user.ts`
- Admin loading skeleton design
- Migrations 0064–0067 (do not re-apply or modify)
