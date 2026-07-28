# Hotfix QA Notes — Stale Authenticated Shell Across Identity Change

Covers a production hotfix for mixed authenticated state: after signing out
of one account and signing into a different account (different club/role),
the first authenticated render could show the new account's page content
but the previous account's club name and role navigation in the app shell
(Header/SideNav/BottomNav), correcting only on manual refresh.

Root cause: sign-out and sign-in both used `router.push(...)` (a soft,
client-side navigation). Next.js's client router cache doesn't know a
Supabase auth identity change just happened via a direct client-side
`supabase.auth.signOut()`/`signInWithPassword()` call, so it could serve
the `(app)` layout's previously-rendered shell (club name, role-based nav)
from cache for one render instead of fetching it fresh under the new
session — even though the leaf page itself (a route not previously visited
in this browser session) rendered correctly.

Fix: every sign-out path and the sign-in success path now perform a full
document navigation (`window.location.replace(...)`) instead of
`router.push`, discarding the entire client-side router cache and forcing
every authenticated surface — shell included — to load fresh under the new
(or absent) session. No multi-club membership logic, RPCs, or migrations
changed.

Sign-out entry points fixed: `SignOutButton.tsx` (Profile),
`AccountMenu.tsx`, `AcceptButton.tsx` (invite email-mismatch sign-out),
`PendingInviteClient.tsx` (pending-invite sign-out). Sign-in entry point
fixed: `SignInForm.tsx` (both the `/welcome` and `/calendar` success
destinations, mechanism only — destination selection logic unchanged).

---

1. **Lakeview multi-club Pro → sign out → Generic one-club Admin.**
   Sign in as the Lakeview multi-club Pro test account, confirm Lakeview/Pro
   nav is showing, sign out, then sign in as `admin@example.com` (Generic
   Club only). Confirm the very first authenticated render shows Generic
   Club in the shell and Admin navigation — no Lakeview/Pro artifact
   anywhere, no refresh needed.

2. **Generic Admin → sign out → Lakeview Pro.**
   Reverse the swap — sign out of `admin@example.com`, sign in as the
   Lakeview Pro account. Confirm the first render shows Lakeview and Pro
   navigation immediately.

3. **Repeat the account swap at least three times without manually
   refreshing.**
   Alternate Generic Admin ↔ Lakeview Pro at least three full round trips —
   confirm every single sign-in shows the correct shell on first render,
   with no occasional stale flash on any repetition.

4. **Sign out through both AccountMenu and Profile.**
   Repeat scenario 1 or 2 twice — once triggering sign-out from the
   AccountMenu dropdown, once from the Profile page's Sign Out button —
   confirm identical correct behavior from both entry points.

5. **Browser Back cannot restore a usable page from the previous account.**
   After signing out, press Back — confirm the browser does not land on an
   interactive authenticated page still showing the signed-out account's
   data (the full-document navigation drops the prior page from the
   session's forward/back-usable history for this purpose). Same check
   after a sign-in swap: Back from the new account's `/calendar` should not
   surface the previous account's authenticated page in a usable state.

6. **Desktop and mobile.**
   Repeat scenarios 1–2 on both a desktop viewport (SideNav/AccountMenu) and
   a mobile viewport (BottomNav/mobile header) — confirm identical behavior
   on both.

7. **Same-account sign-out/sign-in still works.**
   Sign out and immediately sign back in as the *same* account — confirm
   normal behavior: correct club/role shown, no errors, no unexpected
   redirect to `/welcome` for a profile that's already complete.

8. **Failed sign-in remains on the sign-in page with its existing error.**
   Attempt sign-in with a wrong password — confirm the page does not
   navigate anywhere, the existing inline error message appears, and the
   form remains usable for a retry (this path never reaches the navigation
   change).

9. **No previous club name, role navigation, membership list, or account
   data flashes after the new account loads.**
   Across scenarios 1–3, watch closely (including a slow-network throttle
   if available) for any transient flash of the previous club's name, the
   previous role's navigation items, the previous account's membership
   switcher list, or any other previous-account data before the correct
   shell settles — confirm none occurs, since the previous page is fully
   unloaded before the new one begins rendering.
