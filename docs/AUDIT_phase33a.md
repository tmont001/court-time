# Phase 33A — Staff-Managed Operations Capability Audit

**Status:** Read-only audit. No code, migrations, or dependencies were modified.
**Date:** 2026-08-09
**Branch:** phase-33-staff-managed-commercial-foundation
**Scope:** Product capability + commercial audit only. No implementation.

---

## 1. Executive Summary

Court Time has more of the foundation for Staff-Managed Operations than a cold read of the product spec would suggest — but the foundation is a single, narrow, half-finished primitive rather than a system.

In Phase 24 (migration `0056_roster_members.sql`), the team already built a **`roster_members`** table explicitly for "offline/unclaimed club members" — a persistent name/email/phone record an Admin can create **without any Supabase Auth account**. It has:
- an admin-only CRUD surface (`add_roster_member`, `update_roster_member`, `delete_roster_member`, `get_roster_members`),
- a "no account yet" UI in the Admin → Members screen (`AddMemberSheet.tsx`, two explicit modes: "Add and Invite" vs. "Add to roster only"),
- an auto-claim mechanism when a matching-email person later accepts a club invite (`accept_club_invite`, copies blank fields only, never overwrites), and
- exactly one downstream integration: it can be attached to an **event guest row** (`event_guests.roster_member_id`), rendered in the calendar's event roster sheet under a **"No Account Yet"** section.

That is the entire footprint. `roster_members` has **zero relationship** to reservations, programs, lesson requests, notifications, SMS consent, or reporting. Everywhere else in the product — court booking, program enrollment, lesson coordination, communications, admin reporting — a person must already be an authenticated `profiles`/`auth.users` row to exist at all.

This means the "no-account Member" concept is not missing from Court Time; it is **implemented once, in one corner of the product, and mislabeled as a subtype of Guest** rather than as a first-class third identity category. The Phase 33 goal — Staff can manage reservations, events, lessons, communications, and history for a no-account Member — is achievable by **extending `roster_members`' reach**, not by inventing a new identity system. The multi-tenancy/RLS architecture already supports the harder problem (an authorized admin acting on a target identity via SECURITY DEFINER RPC, not `auth.uid() = owner`) almost everywhere except reservations and lesson confirmation.

The gaps are real, tables of them below. But every one of them is an extension of an existing, working pattern, not a rebuild.

**Bottom line: PROCEED**, with the evolutionary path in §9, staged as 33B–33F.

---

## 2. Current Identity/Data Model (text diagram)

```
auth.users (Supabase-managed: email, password, phone unused)
    │  1:1, FK "id -> auth.users(id) on delete cascade"
    ▼
profiles (id, club_id[legacy], first_name, last_name, phone, role[legacy],
          status[legacy], sms_opt_in, sms_opted_in_at, sms_opted_in_ip,
          is_lesson_provider, active_club_id, admin_notes)
    │
    │  user_id FK (1:many across clubs)
    ▼
club_memberships (id, user_id -> profiles, club_id -> clubs, role, status,
                   is_lesson_provider, removed_at, removed_by, invited_by,
                   source_invite_id)     ── RLS: locked, RPC-only access
    ▲
    │ source_invite_id
club_invites (id, club_id, code, email[nullable], role, expires_at,
              accepted_at, accepted_by)  ── token/link, not a person record

roster_members (id, club_id, first_name, last_name, email[nullable],
                 phone[nullable], role[display-only], notes,
                 claimed_by -> auth.users[nullable, GLOBALLY unique],
                 created_by)             ── STANDALONE. No FK from any
                                             activity table points here,
                                             except:

event_guests (id, event_id -> events, display_name, added_by -> profiles,
              roster_member_id -> roster_members[nullable])
                                             ▲
                                             └── the ONLY place roster_members
                                                 is referenced outside its own
                                                 admin CRUD screen

reservations.owner_user_id / created_by / cancelled_by  → profiles ONLY
event_participants.profile_id                            → profiles ONLY
program_enrollments.profile_id                            → profiles ONLY
lesson_requests.member_id / pro_id                        → profiles ONLY
notifications.user_id / notification_preferences.user_id  → profiles ONLY
```

Everything below the `profiles`/`club_memberships` line requires an `auth.users` row to exist, **except** `roster_members` and its one downstream hop into `event_guests`.

---

## 3. Capability Matrix

| Domain | No-account Member support | Label |
|---|---|---|
| Member identity (create persistent person, no login) | `roster_members` table + admin UI + auto-claim on invite accept | **ALREADY SUPPORTED** |
| Reservations (staff books court for a person) | No target-member param on `create_reservation`; `owner_user_id` always hardcoded to caller's own `auth.uid()`; no `roster_members` FK anywhere in `reservations` | **NOT SUPPORTED** |
| Events (staff adds a no-account Member to a roster) | `admin_add_roster_member_to_event` exists, but inserts into `event_guests` with `role='guest'` — conflates no-account Member with true Guest; no waitlist/offer eligibility | **PARTIALLY SUPPORTED** |
| Programs (staff enrolls a no-account Member) | `add_program_member` hard-requires an active `club_memberships` row; zero roster/guest path exists | **NOT SUPPORTED** |
| Lessons (staff coordinates a lesson for a no-account Member) | `admin_create_lesson_request` requires `p_member_id` to already be a `profiles` row; and even for authenticated members, `accept_lesson_proposal` has **no admin override** — confirmation is hard-gated to `auth.uid() = member_id` | **NOT SUPPORTED** |
| Communications (staff emails/texts a no-account Member) | `roster_members.email/phone` exist but have zero wiring to `notifications`, `notification_preferences`, SMS dispatch, or consent columns | **NOT SUPPORTED** |
| Reporting/history | All reporting RPCs join through `club_memberships`/`profiles`; `roster_members` rows are structurally invisible (explicitly documented as intentional in `0096`'s own comments) | **NOT SUPPORTED** (by design, currently) |
| Account conversion (claim without duplication) | `accept_club_invite` already does this for the one existing integration point (profile fields, event_guests stays orphaned) | **PARTIALLY SUPPORTED** |
| Lifecycle / archive | `club_memberships` has soft-delete (`removed_at`/`removed_by`) with restore; `roster_members` has **hard delete only**, blocked once claimed | **PARTIALLY SUPPORTED / ARCHITECTURAL RISK** |
| RLS "admin acts on behalf of member" pattern | Already the dominant pattern for events, programs, membership admin (`admin_add_member`, `set_member_status`, `remove_club_member`, etc.) | **ALREADY SUPPORTED** (pattern exists; just not extended to reservations/lessons target params) |

---

## 4. No-Account Member vs. Guest vs. Authenticated Member — current reality

The product spec (and this audit's brief) insists these stay conceptually distinct. **The current schema does not yet honor that distinction** in the one place it partially exists:

- `event_guests.roster_member_id` (nullable) is the only column separating a roster-linked no-account Member from a true anonymous Guest — but both are surfaced with `role = 'guest'` in `get_event_roster`'s UNION, both are always `status = 'confirmed'`, and both are ineligible for waitlist/offer logic. The UI (`EventRosterSheet.tsx`) does render a distinct **"No Account Yet"** section for roster-linked rows, so the *presentation* layer already partially recovers the distinction the *data* layer collapses.
- Reservations' `guest_names text[]` is pure free text with no identity at all — this is the true "one-off Guest" representation and should stay that way.
- Authenticated Members are the only identity with real capability (self-service booking, RLS-scoped rows, notification delivery).

**Recommendation embedded in the evolutionary path (§9):** stop routing `roster_members` through `event_guests`/`role='guest'`. A no-account Member needs its own identity slot in each activity table (or a shared "club person" reference — see tradeoff in §9), not a flag on the Guest table.

---

## 5. RLS / Multi-Tenancy Findings

Two coexisting, well-separated patterns:

1. **Direct-table RLS, `auth.uid() = owner_column`** — used for self-service writes: `reservations_insert_own`/`_cancel_own`, `event_participants_insert_own`/`_cancel_own`, `lesson_requests` member-side actions, `profiles_update_own_row`. This is the pattern that would break for a no-account Member (they have no `auth.uid()`).

2. **SECURITY DEFINER RPCs, actor-authorized via `current_user_role()`/`current_user_club_id()`, target supplied as a parameter** — used for essentially all admin "on behalf of" actions: `admin_add_member`, `admin_remove_participant`, `admin_offer_spot`, `admin_add_guest`, `set_member_status`, `remove_club_member`, `restore_club_member`, `admin_create_lesson_request`, `update_member_reservation`, `admin_cancel_reservation`. Notably, `club_memberships` itself has **RLS enabled with zero policies and all client privileges revoked** — it is reachable only through this RPC layer. This is exactly the "authorized club admin acts on behalf of another member" shape the audit brief asked whether existed.

**Finding: the authorization architecture for Staff-Managed Operations already exists and is the dominant pattern in the codebase.** The gap is not RLS design — it's that the *target* parameter in reservation-creation and lesson-confirmation RPCs is either absent (`create_reservation` takes no target at all) or typed strictly as a `profiles` FK with no admin override (`accept_lesson_proposal`). No tenant-isolation weakening is implied by closing these gaps; the same actor-authorization pattern extends cleanly.

One existing architectural risk directly relevant to scaling `roster_members`: **`roster_members.claimed_by` is globally unique across `auth.users`** (`0056:21`: `claimed_by uuid unique references auth.users(id) on delete set null`), not scoped per-club. Precisely stated, this means: a single authenticated user can claim at most one `roster_members` row across the entire product, not one per club. It does **not** prevent an authenticated user from *belonging* to multiple clubs — Phase 26's `club_memberships` (`unique(user_id, club_id)`) is a separate mechanism and is unaffected by this constraint. The actual failure mode is reconciliation: if the same person has pre-account roster records at two different clubs (e.g., a touring pro on staff at Club A's roster and also on Club B's roster before either club invites them), only the first `accept_club_invite` claim can succeed — the second club's auto-link step would violate the global unique constraint and fail to link, leaving that club's roster record permanently unclaimed unless worked around. This is already flagged as a known gap in migration `0084`'s comments (`0084:38-46`, describing exactly this scenario and noting it is guarded against at the RPC level, not fixed at the schema level) and worked around, not fixed. It will matter more as multi-club membership (Phase 26) and Staff-Managed usage both grow, specifically for people who accumulate no-account history at more than one club before authenticating.

---

## 6. Current Staff-Managed UX Findings

- **Admin → Members** (`AddMemberSheet.tsx`) already has the right mental model: two explicit add-modes, "Add and Invite" vs. "Add to roster only," with copy stating *"They do not need an online account yet."* This is the natural home to extend, not replace.
- **Calendar → Event Roster** (`EventRosterSheet.tsx`) already merges `profiles` and `roster_members` in a single "Add Member" picker, labels roster entries `"(No account yet)"`, and renders a dedicated "No Account Yet" roster section. This UI pattern is the template to replicate in Reservations, Programs, and Lessons — no new screen paradigm is needed.
- **Admin → Courts/Calendar (booking)**, **Admin → Lessons**, **Admin → Reports**: no equivalent picker or no-account-aware UI exists yet. Booking and lesson-request member pickers source exclusively from `get_members`/`profiles`.
- **No admin communications screen exists at all** under `src/app/(app)/admin` — the only staff→member send paths today are triggered indirectly through event/reservation/waitlist actions, not a direct "message this member" tool.

**Recommendation:** extend the existing Admin Members and Calendar/Roster UI patterns outward (per the audit brief's instruction to prefer extending existing Admin workflows over duplicating screens) rather than building a parallel "Staff-Managed" app surface.

---

## 7. Edge-Case Findings

| Edge case | Current behavior |
|---|---|
| Member without email | Supported today only on `roster_members` (`email` nullable, partial unique index only enforces uniqueness when non-null). `profiles` has no email column of its own — email is inherently required by `auth.users`/Supabase Auth signup, so an *authenticated* member without email is not possible under the current signup flow (email/password only, no phone-auth path). |
| Shared/family email | No constraint prevents two `roster_members` rows with the same email from being *distinct* people in different scenarios, but the auto-claim in `accept_club_invite` matches by exact email, so a shared email would auto-link to whichever `roster_members` row matches first — a real collision risk once roster→auth wiring expands. |
| Duplicate email within one club | `roster_members` enforces `unique(club_id, lower(email)) where email is not null` — blocked at the DB level. No equivalent constraint would apply to `profiles`/`auth.users` since Supabase enforces email uniqueness globally, not per-club. |
| Same person, multiple clubs | Supported for authenticated members via `club_memberships` (`unique(user_id, club_id)`, Phase 26 multi-club foundation) — this is unaffected by the `claimed_by` constraint below. **Partially supported** for `roster_members` reconciliation: `claimed_by` is globally unique per authenticated user, so if that same person has *unclaimed pre-account roster records at two different clubs*, only the first club's `accept_club_invite` can successfully link; the second club's roster record cannot also be claimed by the same account — flagged architectural risk (§5). |
| Member created by staff, then invited later | Exactly the `roster_members` → "Add and Invite" → `accept_club_invite` auto-claim path. Works today for the profile fields (name/phone backfilled only if blank); does **not** migrate any `event_guests` rows tied to the old `roster_member_id` — those remain permanently separate historical records from the new authenticated participation. |
| Invite sent twice | No DB-level duplicate-invite constraint found; de-duplication (if any) is application-level in `add_roster_member_and_invite`, not enforced by schema. |
| Invite email differs from roster record email | Auto-claim match is exact-email; a mismatch means **no link occurs, silently** — no error surfaces, the two identities simply stay unmerged. No manual "link this new signup to that roster record" admin tool exists today. |
| Account already exists before staff creates "new" Member | Not guarded: nothing stops an Admin from creating a `roster_members` row whose email matches an existing `auth.users` account in a *different* club; the two rows are unrelated until/unless that exact person later runs `accept_club_invite` for *this* club. |
| Archived Member later returns | Supported for `club_memberships` via `restore_club_member` (reverses `removed_at`/`removed_by`, scoped to that club only, doesn't touch other clubs or `profiles`/`auth.users`). Not applicable to `roster_members` since it has no archive state (only hard delete, see §8). |
| No-account Member joins event, later creates account | Supported partially: they appear as a `role='guest'` `event_guests` row today; after claiming, no migration/merge of that historical row into `event_participants` happens — it stays a permanently separate, un-reconciled record. |
| Reservation/event history before account creation | Reservations: cannot exist for a no-account Member at all today (no FK path). Events: exists only as an unreconciled `event_guests` row (above). |
| SMS consent before/after account creation | No consent model exists for `roster_members` at all today (no `sms_opt_in`-equivalent columns). Post-claim, the existing single-boolean self-service `sms_opt_in` on `profiles` applies, but only once the person is authenticated and calls `update_sms_preference` themselves — never staff-set today. Building a pre-authentication consent path is a genuine, separate legal/product decision (see §8). |
| Staff accidentally creates duplicate person | No dedup safeguard beyond the per-club unique-email index (which doesn't fire for null-email rows, or across clubs, or against existing `auth.users` accounts). |
| Guest later becomes a Member | `event_guests.roster_member_id` can link a Guest to a `roster_members` identity retroactively (via `admin_add_roster_member_to_event`'s pattern), but there's no RPC to *convert* a pure free-text Guest (`event_guests` with `roster_member_id IS NULL`, or `reservations.guest_names` text) into a `roster_members` record — that would be a manual re-entry today. |
| Admin acting on behalf of Member | Well-supported pattern for events/programs/membership (§5); **not supported** for reservations (no target param) or lesson confirmation (no admin override). |
| Pro acting on behalf of Member | Pros can propose lesson times (`propose_lesson_time`) but cannot accept on the member's behalf (`accept_lesson_proposal` is member-only, no pro/admin override). |
| Club deletion/deactivation effects | Not investigated in this pass (out of the identity-focused evidence gathered); flagged as a follow-up item, not a blocker for 33B. |
| Cross-club data isolation | Strong today via `club_memberships`/`current_user_club_id()` scoping and the fact that `club_memberships` has zero direct-client RLS access. The `claimed_by` gap above is not a data-visibility or isolation leak — it is a *reconciliation* failure (a legitimate claim can be blocked), not unauthorized cross-club access. |

---

## 8. Technical Debt / Architecture Risks

1. **`roster_members.claimed_by` globally unique, not per-club** — a single authenticated user can claim at most one `roster_members` row product-wide. This does not block multi-club *membership* (that's `club_memberships`, unaffected), but it does block reconciling a second club's pre-account roster record to an account that has already claimed a roster record elsewhere. Flagged in-repo (`0084:38-46`) as a known, unaddressed gap. Will compound as Staff-Managed usage and multi-club membership both scale, specifically for people with no-account history at more than one club.
2. **`event_guests` conflates no-account Member and true Guest** under a single `role='guest'` label with no distinct enum value. Any reporting or UI built on top of `get_event_roster` today cannot cleanly separate the two without also checking `roster_member_id IS NOT NULL`, which is a leaky abstraction going into more domains (reservations, programs, lessons) that don't have this table at all.
3. **No reconciliation/merge step when a `roster_members` row is claimed.** Historical `event_guests` rows tied to that `roster_member_id` are not migrated into `event_participants`. If reservations/programs/lessons later grow their own `roster_member_id`-style columns, each will need its own claim-time migration logic (or the identity-unification approach in §9 avoids this entirely).
4. **`roster_members` has no soft-delete/archive state** — only hard `DELETE`, blocked once claimed. This is inconsistent with `club_memberships`' `removed_at`/`removed_by` pattern and with the audit brief's explicit preference for archive over destructive deletion once historical records exist. Becomes a real data-loss risk once `roster_members` accumulates reservation/lesson/program history.
5. **No consent model exists for pre-authentication communication.** `sms_opt_in` is single-boolean, self-service-only, tied to `auth.uid()`. Extending SMS/email to no-account Members requires a genuinely new consent-capture design (staff-attested consent with audit trail, or a lightweight double opt-in specific to non-authenticated recipients) — this is not a simple schema extension, it is a legal/product decision that needs its own scoped checkpoint.
6. **`get_member_activity_history` excludes plain court reservations** (`activity_type` enum is only `'event'|'lesson'`) — a pre-existing gap independent of Staff-Managed work, but it means today's admin member-detail view already under-reports authenticated members' court-booking history; this should be fixed before or alongside extending reporting to no-account Members, or the no-account gap will be built on top of an already-incomplete picture.
7. **Programs have zero no-account-Member (or even Guest) path.** This is the least-supported domain today and will need the most net-new RPC surface.

---

## 9. Smallest Safe Evolutionary Architecture

**Do not create a new `staff_managed_members` table.** `roster_members` already is that table, already has admin UI, already has an auto-claim precedent. The work is in *extending its reach*, not replacing it.

Two technical shapes were considered for wiring `roster_members` into reservations/programs/lessons:

**Option A — Nullable parallel FK + CHECK constraint (recommended starting point, with constraint-relaxation caveat below).**
Add a nullable `roster_member_id` column (FK to `roster_members`) alongside the existing `profile_id`/`owner_user_id`/`member_id` column on each activity table, so that either an authenticated profile or a no-account roster member can be referenced. This mirrors the pattern `event_guests` already uses.
- *Pro:* Existing `profile_id`/`owner_user_id` FKs, RLS policies, and RPC signatures are untouched for rows that continue to reference an authenticated member. No `profiles`/`club_memberships` behavior changes.
- *Con — this is not purely additive.* The current authenticated-identity FK is `NOT NULL` on every table this would touch, so adding a nullable sibling column is not enough by itself; the existing `NOT NULL` (and, in one case, related uniqueness/index assumptions) must also be relaxed, which changes an existing constraint, not just adds a new one. Verified current constraints:
  - `program_enrollments.profile_id uuid not null references public.profiles(id)` (`0087_programs_schema_foundation.sql:208`), with `unique (program_id, profile_id)` (`0087:215`). Supporting a roster-only enrollment row requires dropping the `NOT NULL` on `profile_id` and deciding what the uniqueness constraint should become (e.g., a composite/partial unique constraint covering both identity columns) — not just adding `roster_member_id` alongside it.
  - `lesson_requests.member_id uuid not null references public.profiles(id)` (`0069_lesson_requests.sql:89`). Also note `lesson_requests.pro_id` is separately `not null` (`0069:90`) and the table has a `check (member_id <> pro_id)` constraint (`0069:145-146`) that assumes both columns are populated and comparable — a roster-only `member_id` would need that check (and every RPC/query filtering `where member_id = auth.uid()`, e.g. `0069:175`) re-examined, not just extended.
  - `reservations.owner_user_id uuid not null references profiles(id)` and `reservations.created_by uuid not null references profiles(id)` (`0003_reservations.sql:18, 30`); `cancelled_by` is nullable (`0003:34`). See the dedicated design-gate discussion immediately below — reservations' identity semantics need to be resolved *before* deciding whether `owner_user_id` is even the right column to make nullable, or whether a roster-member booking needs a different column altogether.
  - Every RPC/query that currently assumes the authenticated-identity column is always populated (e.g., `create_reservation`'s hardcoded `owner_user_id = auth.uid()`, `get_program_eligible_members`, `get_member_activity_history`'s joins) would need to be audited and updated for the relaxed-constraint case, not just the new column added — this is real design and migration work, not a single additive `ALTER TABLE ADD COLUMN`.
  - Downstream queries (reporting, "my history," admin detail) also need a `COALESCE`/`UNION` across two identity columns going forward, and claim-time conversion still requires migrating historical rows from `roster_member_id` to `profile_id` per table (repeating the unresolved `event_guests` reconciliation gap in §8, item 3, across every new table it's added to).

**Reservations identity semantics — open design question, not yet resolved.**
Unlike `event_participants`/`program_enrollments`/`lesson_requests` (each of which represents one clear relationship — a person enrolled or requesting), `reservations` already models multiple operationally distinct concerns through the same table and the same `owner_user_id`/`created_by` columns (`0003_reservations.sql:14-47`, evidence in the Reservations research pass): `reason` is a `check (reason in ('member_booking','maintenance','admin_block'))` (`0003:24`), and event-driven court holds are also inserted into this table outside that enum by `create_event` (`0059_admin_pro_scheduling_rules.sql`). Today, for every row, `owner_user_id = created_by = auth.uid()` always — the schema has never had to distinguish "who performed the write" from "who the booking is for" from "is there even a Member on the other end of this row at all." Before proposing any `roster_member_id` column or `CHECK (num_nonnulls(...) = 1)`-style constraint on `reservations` specifically, 33B needs to first answer, as its primary architecture question:
- What does `created_by` mean once staff can book *for* someone else — is it the staff actor, and should that be tracked separately from who the booking is "for"?
- What does `owner_user_id` mean going forward — strictly "the Member/person this reservation is for," or does it stay "whoever the system considers responsible for the row"?
- Is a no-account roster member's court booking even the same kind of row as a Member's self-service booking, or does it need its own `reason`/identity shape?
- Do `maintenance` and `admin_block` rows (and event-driven holds) need to keep tolerating "no Member at all" — i.e., should the eventual identity column(s) even be required to resolve to a person for every `reason` value, or only for `member_booking`?
This audit deliberately does **not** lock a constraint shape for `reservations` — the `num_nonnulls(profile_id, roster_member_id) = 1` pattern that fits `event_participants`/`lesson_requests`/`program_enrollments` may not be the right shape here at all once staff-actor and non-Member `reason` values are accounted for. Resolving this is the first task of 33B, before any reservations migration is drafted.

**Option B — Unify around a stable "club person" identity.**
Introduce a single stable identity (e.g., a `club_people` concept that both `profiles`-backed and `roster_members`-only rows resolve to) and repoint `reservations`, `event_participants`, `program_enrollments`, and `lesson_requests` at that identity instead of `profiles` directly. Claiming an account never requires migrating historical rows — the id never changes.
- *Pro:* Solves the reconciliation problem (§8 item 3) structurally instead of per-table; is the more correct long-term shape the audit brief's "prefer relationships keyed to a stable club-person identity" guidance is pointing at.
- *Con:* Touches the FK target of four high-traffic tables plus all their RLS policies and RPCs — a much larger, higher-risk migration that would need its own multi-checkpoint phase and very careful staged rollout (e.g., add the new identity table, backfill, dual-write, cut over, drop old FK — not a single migration).

**Recommendation:** Start with the **Option A** shape (nullable parallel identity reference, with the necessary `NOT NULL`/uniqueness relaxation documented above) for `lesson_requests` and `program_enrollments`, since those tables have a single, unambiguous person-relationship to extend. For `reservations` — despite it being the highest-value gap (zero no-account wiring today) — resolve the identity-semantics design question above *first*, as the opening task of 33B, before drafting any constraint or column shape there; reservations should not be assumed to follow the same pattern as the other three tables until that question is answered. Also fix the existing `event_guests` conflation (split `role` so a roster-linked no-account Member is no longer labeled `'guest'`). Treat **Option B as a deliberate, separately-scoped future decision** if Option A's per-table reconciliation debt becomes unmanageable — do not default into it without new evidence, per the audit brief's instruction not to refactor identity architecture without repo evidence supporting it.

Fix the `claimed_by` global-uniqueness gap (§5, §8 item 1) as an early, low-risk, high-leverage change regardless of which option is chosen — every other Staff-Managed capability compounds this risk.

---

## 10. What Court Time Can Sell as Staff-Managed TODAY

Honestly, very little beyond a CRM contact list:
- Admin can maintain a persistent roster of club contacts without requiring them to create accounts (`roster_members` + Admin → Members UI).
- Admin can add those contacts to an event's guest list, and the roster sheet clearly labels them "No Account Yet" (distinct from anonymous guests, at the UI layer only).
- That's the entire honest Staff-Managed feature set today. No reservations, no lesson coordination, no communications, and no reporting/history exist for this identity.

**This is not sellable as "Staff-Managed Operations" as scoped in this phase's product model.** It is a partially-built contact list, not a digital front desk.

---

## 11. What Must Be Built Before Calling It a Complete Staff-Managed Product

In priority order (matches §13's checkpoint plan):
1. Reservations: admin-created bookings referencing a no-account Member.
2. Lessons: admin-coordinated lesson requests *and* an admin/pro confirmation override for no-account (and arguably authenticated) members who can't or don't self-serve.
3. Programs: an enrollment path for no-account Members (currently the least-supported domain — zero guest/roster concept exists at all).
4. Communications: a real consent model + email/SMS dispatch path for non-authenticated recipients.
5. Reporting: extend admin overview/reports/member-detail queries to include no-account Member activity once the above exist.
6. Lifecycle: soft-delete/archive for `roster_members`, matching the `club_memberships` pattern.
7. The `event_guests` role conflation fix and the `claimed_by` uniqueness fix (technical debt items that should land early, not last).

---

## 12. Commercial-Tier Implications

Current public pricing ($149/$249/$399 monthly tiers) must not change now — this is analysis only, per the brief.

- A durable **Staff-Managed tier at ~$149–199/month** is plausible *in principle* — the identity/CRM foundation (`roster_members`) already fits that price point's "digital front desk" pitch — but is **not honestly sellable until §11's build-out lands**. Selling it today would be selling a contact list as an operations platform.
- **Member Self-Service mapping to ~$249** is consistent with what already exists in production (booking, events, waitlists, lessons, self-managed profile/notifications) — this tier is accurately represented by current capability.
- A genuine **~$399 tier** would need to be justified by capability, not facility type, per the brief's explicit instruction. Candidates for that differentiation once built: multi-club membership (Phase 26 foundation), reporting/analytics depth (Phase 28), and *both* operating models available simultaneously with staff oversight over self-service members — i.e., a club could let some members self-serve while staff manages others, on one roster, which is exactly what a unified identity model (§9) would make possible.
- **Facility type should not gate tier or model** — the architecture doesn't currently hard-code any such assumption (no schema concept of "facility type" was found), so this is a pricing/positioning decision, not an architecture blocker.

---

## 13. Recommended Phase 33B–33F Checkpoint Plan

- **33B — Identity & Reservations Foundation.** Fix `claimed_by` uniqueness gap. Resolve the reservations identity-semantics design question (§9) first — what `created_by`/`owner_user_id` mean once staff can book for someone else, and whether `maintenance`/`admin_block`/event-driven rows need a different shape — then design and add the appropriate no-account identity reference to `reservations` accordingly, with an admin-only "book for roster member" RPC and UI entry point in Calendar/Courts, mirroring the existing Events roster picker. Extend `get_member_activity_history` to include reservations (fixes an existing gap, §8 item 6) for both identity types.
- **33C — Lessons for No-Account Members.** Extend `lesson_requests` with the same pattern; add admin/pro confirmation override so a no-account Member's lesson can be confirmed without their authentication (and evaluate whether this override should also apply, gated, to authenticated members who can't self-serve — e.g., phone-booked lessons).
- **33D — Programs Parity + Event Identity Cleanup.** Add no-account enrollment to `program_enrollments`. Fix the `event_guests` role conflation so no-account Members are no longer labeled `'guest'`.
- **33E — Communications & Consent for No-Account Members.** Design (with explicit legal/product sign-off, not just engineering) a consent-capture model for non-authenticated recipients; wire `roster_members.email/phone` into the existing `0102`-era delivery-context RPC pattern. Do not reuse the self-service `sms_opt_in` RPC as-is.
- **33F — Reporting, Lifecycle, and Commercial Close-Out.** Extend admin overview/reports to include no-account Member activity across all domains built above. Add soft-delete/archive to `roster_members`. Revisit commercial tier definitions now backed by real capability; this is the appropriate point to scope a payments phase, not before.

Each checkpoint should ship its own read-only capability audit against this document's edge-case table before merging, the same discipline used here.

---

## 14. Likely Migration Needs (names/purposes only — none created)

- Fix `roster_members.claimed_by` uniqueness to be per-club, not global.
- Reservations: shape not yet determined — depends on resolving the identity-semantics design question in §9 (staff actor vs. owner vs. non-Member `reason` values) before any column/constraint is proposed. An admin RPC for staff-created bookings will follow once that shape is decided.
- Add `roster_member_id` to `lesson_requests` (requires relaxing `member_id`'s `NOT NULL` and re-examining the `member_id <> pro_id` check and `member_id = auth.uid()` query assumptions per §9), plus an admin/pro confirmation-override RPC.
- Add `roster_member_id` to `program_enrollments` (requires relaxing `profile_id`'s `NOT NULL` and revisiting its `unique (program_id, profile_id)` constraint per §9), plus an admin enrollment RPC.
- Split `event_guests`/`get_event_roster`'s `role` handling so roster-linked rows are no longer labeled `'guest'`.
- Add consent-capture columns/table for non-authenticated communication (exact shape depends on the 33E legal/product decision — likely a staff-attested consent record with actor, method, timestamp, distinct from the existing self-service `sms_opt_in`).
- Add soft-delete columns (`archived_at`/`archived_by` or equivalent) to `roster_members`.
- Extend `get_member_activity_history`/reporting RPCs to include reservations and no-account Member activity.

---

## 15. Testing Strategy

- Extend the existing QA-checklist discipline used for prior phases (`docs/QA_phase*.md`) with a `QA_phase33x.md` per checkpoint, following established convention.
- For each new "admin acts on behalf of X" RPC, explicitly test: (a) admin in the correct club succeeds, (b) admin in a different club is rejected, (c) non-admin roles are rejected, (d) the target `roster_member_id` already claimed is rejected or correctly redirected to the profile path, (e) cross-club `roster_members` isolation.
- For claim/conversion flows: test the double-claim race (two invite-accept calls for the same roster row), the email-mismatch silent-no-link case, and — once §9's reconciliation logic exists — that historical rows correctly move from roster identity to profile identity without duplication or loss.
- For communications: test that no-account Members cannot receive SMS without whatever explicit consent mechanism 33E defines, and that the existing authenticated-member SMS consent protections are provably unchanged (regression tests against current `0018`/`0102`/`0103` behavior).
- For reporting: verify no-account Member activity appears in admin views without leaking into authenticated-member-only aggregates (e.g., `active_member_count`, which is deliberately scoped to `club_memberships`).

---

## 16. Recommendation

**PROCEED.**

The architecture that would need to support Staff-Managed Operations — actor-authorized SECURITY DEFINER RPCs, a locked-down `club_memberships` table reachable only through them, and an existing no-account identity primitive (`roster_members`) with a working claim/merge precedent — is already the dominant pattern in this codebase, not a foreign concept being bolted on. The gaps (reservations, programs, lessons, communications, reporting) are real and nontrivial, but every one of them is a bounded extension of a pattern that already works somewhere else in the product (events). No evidence surfaced in this audit suggests the existing identity model needs to be torn down or that tenant isolation would need to be weakened to close these gaps.

Two places deserve genuine caution before committing to a specific technical shape, and both should be resolved deliberately at the start of 33B rather than left to accrete table-by-table: the reconciliation problem (§8 item 3, §9's Option A vs. B tradeoff), and reservations' own identity semantics (§9) — `owner_user_id`/`created_by` currently conflate "who booked it," "who it's for," and "is there even a Member on the other end" in a table that also carries maintenance and admin-block rows with no Member at all. That question has no answer proposed in this audit and should be the first design task of 33B.
