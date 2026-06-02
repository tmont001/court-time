# QA Record — Phase 20D

## Pilot Blocker Fixes and Pre-Pilot Usability Improvements

This document records the verification status of each Phase 20D fix as it is
implemented and retested. It accompanies `QA_phase20b.md`, which contains the
full Phase 20B sign-off and the confirmed issue list that drives this phase.

**Phase 20B sign-off:** QA complete. Pilot not approved.
**Confirmed blockers driving Phase 20D:** Issues #4, #5, #8.
**Recommended pre-pilot fixes:** Issues #1, #6.

---

## Checkpoint 20D-A — Issue #8: Pro role access guards + hydration fix

**Status: Complete ✓ — all manual QA passed; pnpm tsc and pnpm build pass**

### What was fixed

Four admin-only pages were missing page-level role guards. The shared
`admin/layout.tsx` correctly passes both `admin` and `pro` through (required
so Pro can access `/admin/events`), but individual pages had no further check.
This allowed Pro users to load real admin-only data on `/admin/courts` and
`/admin/settings`, and caused error pages instead of clean redirects on
`/admin/members` and `/admin/audit-log`.

### Files changed

| File | Change |
|------|--------|
| `src/app/(app)/admin/courts/page.tsx` | Added `role` to profile select; added `if (profile?.role !== "admin") redirect("/calendar")` before courts query |
| `src/app/(app)/admin/settings/page.tsx` | Added `if (profile?.role !== "admin") redirect("/calendar")` before settings queries (role already selected) |
| `src/app/(app)/admin/members/page.tsx` | Added profile fetch (`select("role")`); added redirect guard before `Promise.all([get_members, get_club_invites])` |
| `src/app/(app)/admin/audit-log/page.tsx` | Added profile fetch (`select("role")`); added redirect guard before `get_audit_log` RPC |

`admin/layout.tsx` and `admin/events/page.tsx` unchanged.
No migrations, no RLS changes, no RPC changes.

### Manual QA results

**Admin:**
- [x] `/admin/courts` — loads correctly
- [x] `/admin/settings` — loads correctly
- [x] `/admin/members` — loads correctly
- [x] `/admin/audit-log` — loads correctly
- [x] `/admin/events` — loads correctly; roster controls visible and functional

**Pro:**
- [x] `/admin/events` — loads correctly; roster management accessible
- [x] `/admin/courts` — redirects cleanly to `/calendar`; no court data shown; no error page
- [x] `/admin/settings` — redirects cleanly to `/calendar`; no settings data shown; no error page
- [x] `/admin/members` — redirects cleanly to `/calendar`; no member data shown; no error page
- [x] `/admin/audit-log` — redirects cleanly to `/calendar`; no audit data shown; no error page

**Member:**
- [x] All `/admin/*` routes redirect to `/calendar` (layout guard, unchanged)

---

## Issue discovered during 20D-A QA: `/admin/events` hydration mismatch

**Status: Fixed in 20D-A, pending retest after restart**

### Cause

`AdminEventsClient.tsx` `formatDate` used a single `toLocaleString("en-US", { weekday, month, day, hour, minute })` call combining both date and time fields. When a single `Intl` call includes both date and time parts, **browsers** (en-US) inject an "at" connector between date and time — `"Wed, Jun 3 at 9:00 AM"` — while **Node.js** (which uses a different ICU library build) produces `"Wed, Jun 3, 9:00 AM"`. The mismatch causes a React hydration error on initial render.

This is a known divergence in `Intl.DateTimeFormat` behavior between browser runtimes and the ICU library bundled with Node.js. It is not a locale or timezone issue — it only occurs when date and time fields are combined in a single format call.

### Fix

Split the single `toLocaleString` into two separate calls joined by a space:

```ts
const datePart = d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
const timePart = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
return `${datePart} ${timePart}`;
```

Neither call alone triggers the "at" connector. Both runtimes now produce
identical output: e.g. `"Wed, Jun 3 9:00 AM"`.

The club timezone is preserved in both calls. `suppressHydrationWarning` was
not used. SSR was not disabled. Output format changes from `"Wed, Jun 3 at 9:00 AM"` / `"Wed, Jun 3, 9:00 AM"` (inconsistent) to `"Wed, Jun 3 9:00 AM"` (consistent).

### File changed

| File | Change |
|------|--------|
| `src/app/(app)/admin/events/AdminEventsClient.tsx` | Replaced single `toLocaleString` with split `toLocaleDateString` + `toLocaleTimeString` joined by space |

### Retest results

- [x] Restarted `pnpm dev`; opened `/admin/events` as Admin with console open; refreshed and navigated away/back.
- [x] No hydration mismatch error in console.
- [x] Event date/time rendered consistently in deterministic format (no "at" connector, no visible change after load).
- [x] Event time correct in club timezone.
- [x] `/admin/events` as Pro: page loads; no hydration warning; roster controls present.
- [x] Pro redirects from `/admin/courts`, `/admin/settings`, `/admin/members`, `/admin/audit-log` confirmed clean; no admin-only data or error page before redirect.

---

## Checkpoint 20D-B — Issue #5: Member court-reservation duration selector and RPC validation

**Status: Complete ✓ — migration applied, manual QA passed; pnpm tsc and pnpm build pass**

### Scope

Member court reservations only. `CreateEventSheet.tsx` was not modified.
Admin/pro event duration is unrestricted.

### Files changed

| File | Change |
|------|--------|
| `src/app/(app)/calendar/CalendarShell.tsx` | State type `<60 \| 90>` → `<30 \| 60 \| 90 \| 120>`; pill array `[60, 90]` → `[30, 60, 90, 120]`; added `invalid_duration` → user-friendly message to `rpcErrorMessage` |
| `supabase/migrations/0053_create_reservation_duration_check.sql` | New migration — full `create_reservation` body from 0047 + duration allowlist check |

`CreateEventSheet.tsx` — **untouched**. Confirmed.

### Migration base

Migration `0047_create_reservation_override_check.sql` is the latest definition
of `create_reservation` (five migrations define it: 0003, 0010, 0037, 0043, 0047).
Migration 0053 reproduces the 0047 body exactly, inserting only the duration
check between the existing `p_ends_at <= p_starts_at` guard and the Phase 17A
override/hours block.

### Applying migration 0053

**Apply in Supabase SQL Editor before running manual QA against the database.**

1. Open your Supabase project → SQL Editor.
2. Paste the full contents of `supabase/migrations/0053_create_reservation_duration_check.sql`.
3. Run. Expected: no error; `create or replace function` completes.
4. Verify:
   ```sql
   select prosrc from pg_proc where proname = 'create_reservation';
   -- Expected: body contains 'not in (30, 60, 90, 120)' duration check
   ```

### Manual QA results

- [x] Migration `0053` applied successfully in Supabase SQL Editor.
- [x] Verified `create_reservation` function body includes `not in (30, 60, 90, 120)` duration check.
- [x] Booking sheet shows exactly four choices: **30 min**, **60 min**, **90 min**, **120 min**. Default remains 60 min.
- [x] **30-minute reservation:** booked successfully; verified in DB.
- [x] **60-minute reservation:** booked successfully; verified in DB.
- [x] **90-minute reservation:** booked successfully; verified in DB.
- [x] **120-minute reservation:** booked successfully; verified in DB.
- [x] **45-minute direct RPC attempt:** rejected with `invalid_duration`.
- [x] **Special-hours override regression:** booking beyond special closing hours rejected; booking ending within window succeeded.
- [x] **Booking confirmation notification regression:** passed.
- [x] `CreateEventSheet.tsx` untouched; admin/pro event duration unrestricted.

---

## Checkpoint 20D-C — Issue #4: Invited-user signup from `/join/<code>`

**Status: Not yet started**

Must preserve email verification. Must not assume invite redirect automatically
establishes an SSR-authenticated session without inspecting the existing
callback/confirmation architecture first.

---

## Checkpoint 20D-D — Issues #1 and #6: Pre-pilot usability fixes

**Status: Not yet started**

- Issue #1: Admin roster and occupancy counts stale after mutations.
- Issue #6: Members cannot manage/cancel own court reservations from Calendar.

---

## Checkpoint 20D-E — Final sign-off

**Status: Not yet started**
