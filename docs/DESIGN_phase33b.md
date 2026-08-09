# Phase 33B — Staff-Managed Identity Architecture: Design Gate

**Status:** Design gate only. No code, migrations, or database changes made. Not committed.
**Date:** 2026-08-09 (Revision 2 — resolves two design gaps identified before commit; see note below)
**Depends on:** Phase 33A audit (`docs/AUDIT_phase33a.md`), committed.
**Purpose:** Decide the identity architecture *before* any activity table accumulates a parallel identity column, and design the first Staff-Managed reservation workflow conceptually.

**Revision 2 note:** The overall direction below (§1–§11) is approved: reject per-domain parallel identity as the long-term architecture; evolve `roster_members` into the stable, club-scoped Member identity; authentication remains an optional link to that identity; `club_memberships` remains the authenticated authorization/membership layer; true Guests remain separate. Revision 2 resolves two gaps in the original draft before commit: (1) the 0107 backfill was described as "insert a row for every membership," which is unsafe — §12 below replaces it with a deterministic classification algorithm; (2) §12/§16 of the original draft contradicted each other about whether the new reservation subject column is always populated for `member_booking` rows — §13 below establishes a single invariant and resolves it. §12–§19 of the original draft are superseded by §12–§21 below; §1–§11 are unchanged and still current.

---

## 1. Current Reservation Identity Semantics

`reservations` (`0003_reservations.sql`, extended by `0004`, `0053`, `0059`, `0097`, `0098`) has three identity-shaped columns — `owner_user_id` (NOT NULL), `created_by` (NOT NULL), `cancelled_by` (nullable) — all FKs to `profiles(id)`. The `reason` enum has grown across migrations to its current five values (`0069_lesson_requests.sql:53`): `'member_booking' | 'maintenance' | 'admin_block' | 'event' | 'pro_lesson'`.

**These columns do not mean the same thing across `reason` values.** Verified per insert path:

| `reason` | Insert path | `owner_user_id` = | `created_by` = | Real "subject" (person the court is for), if any |
|---|---|---|---|---|
| `member_booking` | `create_reservation` (`0059:151-159`) | `auth.uid()` (the booking member) | `auth.uid()` (same) | **`owner_user_id` — a true SUBJECT column, today always self.** |
| `maintenance` | `create_maintenance_blocks` (`0024:56-64`) | `auth.uid()` (the admin who ran the RPC) | `auth.uid()` (same) | **None.** `owner_user_id` here is a placeholder — an admin's own id used to satisfy the NOT NULL constraint, not a person occupying the court. This is RESOURCE OCCUPANCY, not a member relationship. |
| `admin_block` | *(enum value exists in the CHECK constraint and is counted in `0096_reporting_sections.sql:124`, but no RPC found in any migration that inserts a row with this reason)* | — | — | **Dead/reserved value.** Flagged for follow-up, not load-bearing for this decision. |
| `event` | `create_event` (`0059:237-244`) | `auth.uid()` (the event's admin/pro creator) | `auth.uid()` (same) | **None.** Same RESOURCE OCCUPANCY shape as maintenance — the real participants live in `event_participants`, reachable via `event_id`, not via `owner_user_id`. |
| `pro_lesson` | `accept_lesson_proposal` (`0101:469-484`) | **`v_request.pro_id`** — the *pro*, not the member | **`auth.uid()`** — the *member* accepting the proposal | **Not on this row at all.** The member is reachable only by joining back through `lesson_requests.linked_reservation_id → lesson_requests.member_id`. Proven directly: `_lesson_check_member_availability` (`0101:92-138`) checks the member's lesson conflicts by querying `lesson_requests.member_id`/`proposed_starts_at`/`proposed_ends_at` — it deliberately does **not** use `reservations.owner_user_id` for this, because for `pro_lesson` rows that column holds the pro, not the member. |

**Conclusion, with proof:** `owner_user_id` already carries three distinct meanings today (true booking subject / actor-only placeholder / pro-schedule occupant), and `created_by` is not consistently "the actor who performed the write" either in the sense of "the staff/self party" — for `pro_lesson` it's the *member*, because the member's own accept action is what fires the INSERT. **A single generic `CHECK (num_nonnulls(x, roster_member_id) = 1)` bolted onto `owner_user_id` would be semantically wrong for 3 of 5 reason values** — `maintenance`/`admin_block`/`event` have no real "member subject" to make exclusive-OR against at all, and `pro_lesson`'s real subject isn't in this table. This confirms the audit brief's instruction not to assume a generic constraint works here.

`event_id` (nullable, no FK constraint per `0003_reservations.sql:33` — later migrations don't appear to add one) links an `event`-reason row back to `events`; `linked_reservation_id` lives on `lesson_requests`, not `reservations` (the FK points the other direction: `lesson_requests.linked_reservation_id → reservations.id`, `0101:123`), and is used to soft-cancel-and-replace the reservation on a lesson reschedule (`0101:288-291`). `guest_names text[]` (`0003:27`) is pure free text, unrelated to any of the above, and only meaningful for `member_booking` rows (secondary players on a self-service court booking).

**Actor / Subject / Resource-Occupancy mapping requested by this checkpoint:**
- **ACTOR** (who performed the operation) = `created_by`, consistently, across all five reason values including `pro_lesson` (where the actor is the accepting member, not staff — still correctly "whoever's session ran the INSERT").
- **SUBJECT** (the Member/no-account Member the court is for) = `owner_user_id` **only** for `member_booking`; **does not exist as a column** for `maintenance`/`admin_block`/`event`; and is **misassigned** to the pro for `pro_lesson` (the true subject — the member — lives one hop away in `lesson_requests`).
- **RESOURCE OCCUPANCY** (no person at all) = `maintenance`, `admin_block`, `event` rows, where `owner_user_id` is present only because the column is `NOT NULL`, not because a person is being booked for.

Also confirmed this revision, directly relevant to §13's nullability decision: the GiST exclude constraint that prevents overlapping bookings (`0003_reservations.sql:43-46`) is keyed on `court_id` + time range only — it has no dependency on `owner_user_id` at all, so relaxing that column's nullability cannot affect double-booking prevention. Confirmed via direct read: `exclude using gist (court_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status in ('pending','confirmed'))`.

---

## 2. Constraint / Blast-Radius Audit

| Table | Current identity FK(s) | NOT NULL? | Unique constraint(s) | Downstream affected |
|---|---|---|---|---|
| `reservations` | `owner_user_id`, `created_by` → `profiles(id)`; `cancelled_by` nullable | `owner_user_id`/`created_by` **NOT NULL** | GiST exclude on `(court_id, tstzrange)` for pending/confirmed (`0003:40-46`) — not identity-related but interacts with any new subject column via conflict-checking helper functions | `create_reservation`, `update_member_reservation`, `cancel_member_reservation`, `admin_cancel_reservation(_v2)`, `create_maintenance_blocks`, `create_event`, `accept_lesson_proposal`/reschedule path, `_lesson_check_member_availability`/`_lesson_check_pro_availability`, `my-schedule` query, admin overview "today's bookings" query, `get_member_activity_history` (currently excludes reservations entirely — separate pre-existing gap), `Database["public"]["Tables"]["reservations"]` in `src/lib/db/types.ts:333-395` |
| `event_participants` | `profile_id` → `profiles(id)` | **NOT NULL** (`0004:...`) | `unique(event_id, profile_id)` | `join_event`, `leave_event`, `accept_waitlist_offer`, `decline_waitlist_offer`, `admin_add_member`, `admin_remove_participant`, `admin_force_confirm`, `admin_offer_spot`, `get_event_roster`, roster UI, `get_member_activity_history` |
| `event_guests` | `roster_member_id` → `roster_members(id)`, nullable — **the one existing precedent for this whole problem** | `display_name` NOT NULL, `roster_member_id` nullable | partial `unique(event_id, roster_member_id) where roster_member_id is not null` | `admin_add_guest`, `admin_remove_guest`, `admin_add_roster_member_to_event`, `get_event_roster`'s UNION (hardcodes `role='guest'`) |
| `program_enrollments` | `profile_id` → `profiles(id)` | **NOT NULL** (`0087:208`) | `unique(program_id, profile_id)` (`0087:215`) | `add_program_member`, `remove_program_member`, `join_program`, `leave_program`, `accept/decline_program_waitlist_offer`, `get_program_eligible_members` (sources only `club_memberships`, no roster path at all today) |
| `lesson_requests` | `member_id`, `pro_id` → `profiles(id)` | **both NOT NULL** (`0069:89-90`); `check(member_id <> pro_id)` (`0069:145-146`) | none beyond PK | `submit_lesson_request`, `admin_create_lesson_request`, `accept/decline_lesson_proposal`, `propose_lesson_time`, `cancel_lesson`, `_lesson_check_member_availability`/`_lesson_check_pro_availability`, `get_my_lesson_requests`, `get_pro_lesson_requests` |
| `roster_members` | `claimed_by` → `auth.users(id)`, nullable, **globally unique** (the flagged reconciliation gap) | `first_name`/`last_name` NOT NULL; `email`/`phone` nullable | `unique(club_id, lower(email)) where email is not null`; `claimed_by` unique (global) | `add_roster_member`, `add_roster_member_and_invite`, `update_roster_member`, `delete_roster_member`, `get_roster_members`, `accept_club_invite`'s auto-link step |
| `profiles` | `id` → `auth.users(id)`, PK **is** the FK | N/A (PK) | PK uniqueness only | Every RLS policy using `auth.uid()`, every SECURITY DEFINER RPC's actor resolution, `handle_new_user()` trigger |
| `club_memberships` | `user_id` → `profiles(id)` | **NOT NULL** (`0081:74`) | `unique(user_id, club_id)` | `_current_user_active_membership()`, `current_user_role()`, `current_user_club_id()`, `set_member_status`, `remove_club_member`, `restore_club_member`, `get_members`, all reporting RPCs (`0095`/`0096`) |

**No migration touching any of these tables' identity columns is purely additive.** Every path that would let a no-account identity participate requires relaxing an existing `NOT NULL` (or, per §1, is semantically inapplicable to begin with, as with `reservations.owner_user_id` for non-`member_booking` rows) and revisiting the associated unique constraint's scope.

---

## 3. Option A — Parallel Identity FKs (per table)

Add a nullable `roster_member_id` (or equivalent) column next to each table's authenticated-identity column, with per-table exclusivity logic (not one shared CHECK — proven not to be reusable in §1).

- **`event_participants`**: relax `profile_id` to nullable, add nullable `roster_member_id`, add `CHECK (num_nonnulls(profile_id, roster_member_id) = 1)`, widen `unique(event_id, profile_id)` to a composite/partial pair of unique indexes.
- **`program_enrollments`**: same shape, same relaxation of `profile_id`/`unique(program_id, profile_id)`.
- **`lesson_requests`**: relax `member_id` (not `pro_id` — a pro must always be authenticated), add nullable `roster_member_id`, re-derive the `member_id <> pro_id` check to also cover the roster case, and re-audit every `where member_id = auth.uid()` query (`0069:175`, `0070:383-384`, `0101` throughout) since those assume an authenticated member.
- **`reservations`**: per §1, no single shape applies. Would need its *own* bespoke design per reason value — effectively already conceding this option doesn't generalize cleanly to the highest-value table.

**Why this is the anti-pattern the audit brief warns against:** account conversion (§6) under Option A requires an explicit **per-table UPDATE migration** at claim time — every row referencing `roster_member_id = X` must be rewritten to `profile_id = Y` (or the two identities stay permanently split, exactly as already happens today with `event_guests` per Phase 33A's finding that claimed roster rows never reconcile their historical `event_guests` rows). Extending this pattern to reservations, programs, and lessons means **the same unresolved reconciliation gap gets replicated three more times**, each with its own race-condition surface (a claim happening concurrently with a new no-account booking, a promotion RPC mid-flight, etc.). This is precisely the "activity-by-activity history migration every time someone creates an account" the brief instructs against.

**Where it does not apply cleanly at all:** the audit brief's own framing ("Do not assume the same exact CHECK works on every table") is proven correct by §1 — `reservations` cannot use this shape without first resolving what "subject" even means per `reason`.

---

## 4. Option B — Stable Club-Person Identity

Introduce one stable, club-scoped identity that exists independent of authentication. Activity tables reference *that* identity; authentication (an `auth.users`/`profiles` row) attaches to it optionally, whenever it exists, without ever changing the identity's own id.

- New identity carries: `id` (stable PK), `club_id`, `first_name`/`last_name`, optional `email`/`phone`, and an optional link to `profiles`/`auth.users` once authenticated.
- `reservations.owner_user_id`-equivalent (see §13), `event_participants.profile_id`, `program_enrollments.profile_id`, `lesson_requests.member_id` all get repointed to this identity's id instead of `profiles.id` directly.
- Claiming an account **never rewrites history** — the identity's id is constant before and after authentication; only a "linked to this profile" pointer is set once.

**Cost:** this is a genuinely larger migration — it touches the FK target of four high-traffic tables plus their RLS policies and every RPC that currently assumes `profile_id`/`member_id`/`owner_user_id` resolves directly to `auth.uid()`. It requires a staged rollout (add the identity table, backfill one row per existing `profiles`/`club_memberships` pairing, dual-write or view-based compatibility period, cut activity tables over one at a time, retire the direct `profiles` FK). It is not a single migration; it is the shape of a multi-checkpoint sub-phase.

**Benefit:** it is the only option that satisfies "history remains attached to the same business identity" (the brief's own success criterion) **without a recurring reconciliation step per table, per claim event.**

---

## 5. Option C — Evolve an Existing Table Instead of a New `club_people` Table

The brief asks to prove, not assume, viability. Evaluated both candidates:

**`club_memberships` as the stable identity — not viable.** `club_memberships.user_id` is `NOT NULL references profiles(id)` (`0081:74`) — a membership row cannot exist without an already-authenticated profile. This is backwards from what a pre-authentication identity requires (must exist *before* any `profiles` row does). Making `user_id` nullable would mean every consumer of `club_memberships` — `_current_user_active_membership()`, `current_user_role()`, `current_user_club_id()`, and the entire Phase 26 active-club authorization foundation (`0082`/`0083`) — would need to tolerate a null actor identity in what is currently the authorization core of the app. That blast radius is security-sensitive, not just additive, and conflates "membership/role state" with "raw identity existence." **Rejected.**

**`roster_members` as the stable identity — structurally viable, with real cost.** `roster_members` already has the right shape for a pre-authentication identity: it exists independent of `auth.users` (`claimed_by` nullable), is club-scoped, carries name/email/phone, and already has a working (if incomplete) claim precedent in `accept_club_invite`. Evolving it into the universal identity — used by *both* no-account and authenticated people — requires:
1. Fixing the global-uniqueness gap on `claimed_by` (already flagged as a prerequisite regardless of which option wins — see Phase 33A §5/§8).
2. **Backfilling a `roster_members` row for every existing authenticated `profiles`/`club_memberships` pairing** — today, authenticated members have no `roster_members` row at all; the table currently means specifically "no account yet." This backfill is mechanical and additive (pure INSERTs, no data loss), but it is a real one-time migration over production data — **§12 below replaces the earlier blind-insert description with a deterministic classification algorithm.**
3. Still repointing `reservations`/`event_participants`/`program_enrollments`/`lesson_requests` FKs at `roster_members.id` instead of `profiles.id` — **this is the same FK-repointing blast radius as Option B**, just executed against an existing table rather than a brand-new one.
4. A **product-language shift**: the Admin → Members UI's "Add to roster only... They do not need an online account yet" copy (`AddMemberSheet.tsx:198,286`) and the "No Account Yet" roster-sheet section (`EventRosterSheet.tsx:677-716`) both currently equate "is a roster_members row" with "has no account." If `roster_members` becomes the universal identity, that equation breaks and both UI surfaces need to key off `claimed_by IS NOT NULL` instead of "is a `roster_members` row at all" — a real, if small, UX-copy and query-shape change, not just a schema one.

**Conclusion:** Option C is functionally **Option B's architecture, built by extending `roster_members` instead of creating a new `club_people` table** — it saves creating net-new schema surface and reuses the existing (if partial) claim precedent, but it does **not** avoid the FK-repointing cost that is Option B's actual expense. The genuine saving is smaller than the framing "smallest architecture" might suggest; it is real, but modest.

---

## 6. Account-Conversion Walkthrough — Six Scenarios

| Scenario | Option A (parallel FKs) | Option B / C (stable identity) |
|---|---|---|
| **1. Jane: 10 roster bookings → creates account → sees them** | Requires an explicit UPDATE across every activity table rewriting `roster_member_id = Jane's roster row` to `profile_id = Jane's new profile`, inside the claim transaction. Correct only if every table's migration step is included and atomic; a table added later without its own reconciliation logic silently orphans history (exactly what already happened to `event_guests`, per Phase 33A). | No rewrite. Jane's stable identity id is unchanged; only a `claimed_by`-equivalent pointer is set. Her 10 bookings were always attached to that id. |
| **2. Jane: roster member at Club A and Club B → one account → claims both** | Blocked today by `claimed_by`'s global uniqueness regardless of option (§8 item 1, Phase 33A) — must be fixed first either way. Once fixed, still requires two separate per-table migrations (one per club) under Option A. | Once `claimed_by` uniqueness is fixed to be per-club, each club's stable identity independently links to the same `profiles` row — no history rewrite in either club. |
| **3. Jane already has a Club A account → Club B independently creates her as no-account → Club B later invites the same account** | Club B's roster row and Jane's existing `profiles` row are unrelated until Club B's own `accept_club_invite` runs its auto-link-by-email step, then Club B's activity-table rows referencing the old `roster_member_id` need their own migration to `profile_id`. | Club B's stable identity links to Jane's existing `profiles` row on invite acceptance; Club B's activity history (already keyed to the stable identity, never to `profiles` directly) needs no rewrite — only the link is set. |
| **4. Two roster rows accidentally represent Jane in one club** | Manual admin merge tool required either way (not designed here) — under Option A, merging means moving every activity row's `roster_member_id` from the duplicate to the surviving row, table by table. | Same manual-merge need exists, but is a single identity-table merge (repoint one `roster_members`/stable-identity row's dependents to the other) rather than N per-table rewrites — smaller surface for the same unavoidable admin tool. |
| **5. Shared/family email** | `roster_members`' per-club unique-email index already tolerates this poorly (first claim wins); unrelated to which option is chosen — this is a `roster_members`/`accept_club_invite` matching-logic problem in both options, not solved by either. Flag as a 33E-adjacent consent/identity question, not a reservations-architecture one. | Same. |
| **6. Roster member without email later creates an account with email** | Auto-link by email match in `accept_club_invite` still requires an exact email match to find the roster row at all; if there was never an email on file, no automatic link is possible — an admin must manually link. Unaffected by the option chosen. | Same. |

**Net finding:** Scenarios 1–3 (the ones that matter most for "history remains attached... no duplicate activity or destructive migration") are cleanly correct under Option B/C and require bespoke, replicated reconciliation logic under Option A. Scenarios 4–6 are matching/consent problems orthogonal to the identity-architecture choice and need their own tooling regardless.

---

## 7. Multi-Club Implications

Authenticated multi-club membership already works correctly today via `club_memberships` (`unique(user_id, club_id)`, Phase 26) and is **unaffected by any option chosen here** — that mechanism is untouched. The multi-club risk specific to this decision is entirely the `roster_members.claimed_by` global-uniqueness gap (Phase 33A §5/§8, precision-corrected): under **any** option, a person with unclaimed no-account history at two different clubs can only successfully claim the first one until that constraint is scoped per-club instead of globally. **This fix is a prerequisite for all three options, not a differentiator between them**, and should be done first regardless of which architecture wins.

---

## 8. Guest / No-Account Member / Authenticated Member Distinction

Per Phase 33A §4, the current schema already collapses no-account Members into Guests inside `event_guests` (`role='guest'` for both, distinguished only by nullable `roster_member_id`). **This checkpoint's product requirement — "Do NOT present a no-account Member as a Guest" — cannot be satisfied by extending that pattern.** Under any option chosen, a no-account Member must get a first-class identity slot (a real FK reference, not a `role` string value shared with true guests) in every activity table it participates in. `reservations.guest_names text[]` remains the correct, unrelated mechanism for true one-off Guests (no persistent identity, no claim path, no history) — it should not be touched by this work.

---

## 9. RLS / Security Implications

Per Phase 33A §5, the actor-authorization pattern already used throughout the codebase — SECURITY DEFINER RPCs, actor authorized via `current_user_role()`/`current_user_club_id()`, target supplied as a parameter, `club_memberships` itself having zero direct-client RLS access — extends cleanly regardless of which identity option is chosen, **because it already authorizes the actor, not the target's own row ownership.** No option here requires weakening tenant isolation: whichever identity a no-account Member's activity rows reference, the authorization check stays "is the caller an admin/pro in *this* club," scoped exactly as today.

One security-relevant distinction between options: under Option A, a `profiles`-nullable `event_participants`/`lesson_requests` row means any RLS policy or RPC that currently assumes `profile_id`/`member_id` is a real authenticated user (e.g., a stray `where member_id = auth.uid()` filter) could silently exclude — never incorrectly include — no-account rows, which is a safe failure direction but still requires re-auditing every such assumption per table (§3). Under Option B/C, the stable identity is always present and non-null; only whether it *links* to an authenticated profile varies, which is a smaller, single-point re-audit (does this RPC require the identity to be claimed?) rather than N scattered nullability re-audits.

---

## 10. Decision Matrix

Scored 1 (worst) – 5 (best) for this product's actual near-term needs, not theoretical elegance.

| Criterion | Option A | Option B | Option C |
|---|---|---|---|
| 1. Migration risk to existing production data | 4 (small, incremental per-table changes) | 2 (large, staged, multi-table FK repoint) | 2 (same repoint cost, plus a backfill step) |
| 2. Amount of existing app code affected | 3 (moderate, but repeated per table) | 2 (broad, one-time) | 2 (broad, one-time, same as B) |
| 3. Account-conversion correctness | **1** (requires per-table history rewrite or accepts permanent split, per §6) | **5** (no rewrite ever needed) | **5** (same as B) |
| 4. Multi-club correctness | 3 (unaffected either way; `claimed_by` fix is a shared prerequisite) | 3 (same) | 3 (same) |
| 5. Distinguish no-account Member vs. Guest | 3 (achievable, but requires per-table exclusivity logic and still risks a `role`-string shortcut like `event_guests`) | 4 (one identity type, cleanly separate from `guest_names`) | 4 (same as B) |
| 6. RLS / tenant isolation | 4 (safe, but N points of re-audit) | 4 (safe, one point of re-audit) | 4 (same as B) |
| 7. Reporting simplicity | 2 (every query needs `COALESCE`/`UNION` across two identity columns, per table) | 5 (one identity column everywhere) | 5 (same as B) |
| 8. Future communications identity | 2 (no-account contact info still scattered per claim state) | 4 (one identity to resolve email/phone/consent from, claimed or not) | 4 (same as B) |
| 9. Ease of incremental rollout | **5** (genuinely can land one table at a time, immediately) | 2 (needs a full staged multi-step rollout before any table benefits) | 2 (same, plus the backfill step) |
| 10. Long-term technical debt | **1** (debt is the design, not a side effect — compounds with every table and every claim event) | 5 (one-time cost, no recurring debt) | 5 (same as B, once the one-time cost is paid) |

**Totals:** A = 28, B = 36, C = 36.

B and C tie on every criterion except #1 and #2, where C carries a small additional backfill cost but saves net-new schema surface. Per §5, C is Option B's architecture on a reused table, not a cheaper alternative to it.

---

## 11. Explicit Architecture Recommendation — APPROVED

**Adopt the Option B/C shape: a stable, club-scoped identity that exists independent of authentication, built by evolving `roster_members` into that role rather than creating a new `club_people` table from scratch** — i.e., Option C, understood honestly as Option B's benefits at a modestly smaller net-new-schema cost, not as a cheap shortcut.

**Reject Option A explicitly.** It scores best only on short-term rollout ease and migration size — exactly the two axes the brief warns not to over-weight. Every criterion that touches the actual product requirement — account conversion, reporting, future communications — Option A loses decisively and predictably, not marginally.

**This is a staged decision, not a single migration.** Do not attempt to cut all four activity tables (`reservations`, `event_participants`, `program_enrollments`, `lesson_requests`) over in one migration. §12–§15 scope the first concrete step narrowly.

---

## 12. Final Stable-Identity Invariant

> **Every club that a person is meaningfully associated with — whether created by staff or reached self-service — has exactly one `roster_members` row representing that person's business identity in that club. That row's `id` is permanent once created and is never reissued, merged away, or replaced by this or any later migration described in this document. A `profiles`/`auth.users` account optionally links to it through `roster_members.claimed_by` (name retained — see §17); `claimed_by IS NULL` means no-account Member, `claimed_by IS NOT NULL` means linked/authenticated. `club_memberships` remains the sole authoritative source of authenticated role, status, and authorization for that club and is never treated as an identity table — identity and authorization stay separate layers, matching how the codebase already separates `profiles` (identity/contact) from `club_memberships` (role/status per club). True Guests (`event_guests` free-text rows without `roster_member_id`, `reservations.guest_names`) remain structurally outside this identity system entirely — no `roster_members` row, no claim path, no history.**

This single sentence resolves the original draft's §12/§16 contradiction: the new reservation column is **always** populated for `member_booking` rows going forward (self-service or staff-created, claimed or not) — there is no "may be left null for continuing self-service bookings" exception. What varies is only whether `owner_user_id` is also populated (§13) — never whether the stable-identity reference is.

---

## 13. 0107 Preflight Classifications, Backfill Algorithm, and Conflict Rules

Replaces the earlier "insert a `roster_members` row for every `club_memberships` row" description, which was correctly flagged as unsafe. The corrected algorithm classifies every `club_memberships` row into exactly one of four outcomes before any mutation runs.

**Scope note:** classification runs over **every** `club_memberships` row, including ones with `removed_at IS NOT NULL` (soft-removed memberships), not only currently-active ones. This is required so that historical `member_booking` reservations tied to a since-removed member still have a stable identity to backfill against later (§14) — omitting removed memberships would silently orphan their history.

### Inputs, per `club_memberships` row being classified
- `club_id`, `user_id` (→ `profiles.id`)
- `v_email` = `lower(trim(auth.users.email))` for that profile (always present — email/password-only signup, confirmed in Phase 33A)
- `v_first_name`, `v_last_name` from `profiles`

### Classification precedence (evaluated in this exact order)

**A — Already linked.** A `roster_members` row exists where `club_id` matches and `claimed_by = user_id`. → **Reuse it, no mutation.** (At most one such row can exist under both the current global-unique `claimed_by` index and the corrected per-club version, so no ambiguity is possible here.)

**B — Safe auto-link candidate.** Only evaluated if A found nothing. A `roster_members` row exists where `club_id` matches, `claimed_by IS NULL`, and `lower(email) = v_email`. The existing `unique(club_id, lower(email)) where email is not null` index guarantees at most one such row. Before auto-linking, apply a corroboration check against the row's `first_name`/`last_name`:
  - Both blank/NULL on the roster row → nothing to contradict → **corroborated, auto-link (set `claimed_by = user_id` on the existing row).**
  - Both populated and match `v_first_name`/`v_last_name` case-insensitively → **corroborated, auto-link.**
  - Only one of the two populated and it matches → **corroborated, auto-link.**
  - Populated and clearly mismatched (e.g., roster row says "Bob Smith," profile says "Alice Jones") → **do not auto-link — this is Classification D**, not B. Email alone is not sufficient trust for an irreversible identity link.

**C — No existing row correlates.** Neither A nor a corroborated B applies (including the case where the roster row has no email at all, so B could never have matched). → **Create a new `roster_members` row for this club**, `claimed_by = user_id` (certain, not inferred — this row is being created specifically to represent this authenticated person), name copied from `profiles`, email copied from `auth.users.email`, phone copied from `profiles.phone`.

**D — Conflict. Never auto-resolved.** Any of:
  - A name-mismatched email candidate from Step B (looks like two different people sharing an email).
  - A `roster_members` row in this club whose `claimed_by` is already set to a **different** authenticated user than the one being classified, in a way that would otherwise have been treated as the email candidate (a stale or incorrect prior claim).
  - Any defensive anomaly the preflight query finds outside the clean A/B/C shape (e.g., more than one roster row in the same club appears linked to the same user — should be impossible under current constraints, but checked rather than assumed).

  → **Migration does not run while unresolved D rows exist.** No silent merge, ever — per explicit instruction.

### Fail-closed rule
Run the preflight query (below) first, read-only, against production data. If its D-count is nonzero, each D row is reviewed and resolved by hand (an admin corrects a stale `claimed_by`, or determines the "colliding" roster row is a genuine duplicate to be merged/removed via existing admin tooling) **before** 0107 is finalized. If a D-shaped situation is somehow still encountered at apply time despite a clean preflight (data changed in between), the per-row migration logic must `RAISE` and roll back the whole migration rather than guess.

### Explicitly out of scope for 0107
- Deduplicating pre-existing unclaimed `roster_members` rows unrelated to any authenticated user (Scenario 4, §6) — 0107 only resolves "does this authenticated membership have a correct, single roster identity," not general roster hygiene.
- Reconciling `event_guests` rows already tied to a `roster_members.id` that gets classified A or B here — that remains the separate, already-flagged gap (Phase 33A §8 item 3), untouched by this migration.

### Preservation guarantee
By construction: Classification A performs no mutation at all; Classification B links (`UPDATE ... SET claimed_by`) the *existing* row rather than creating a new one. Any pre-account history already attached to that `roster_members.id` (e.g., `event_guests.roster_member_id` references) survives under its original, unchanged id in both cases. Only Classification C creates new rows, and only when nothing pre-existing was found to collide with. **No existing `roster_members.id` is ever destroyed, replaced, or silently merged by this algorithm.**

### Conceptual preflight verification query (illustrative only — not part of migration 0107, run ad hoc for review)

```sql
-- Conceptual only. Name-corroboration is shown as a comment, not a literal
-- boolean expression, since it needs whitespace/case normalization logic
-- that belongs in a real function, not this illustrative query.
with membership_identity as (
  select cm.id as membership_id, cm.club_id, cm.user_id, cm.removed_at,
         lower(trim(u.email)) as v_email,
         p.first_name, p.last_name
  from club_memberships cm
  join profiles p    on p.id = cm.user_id
  join auth.users u  on u.id = cm.user_id
  -- deliberately no "removed_at is null" filter — see scope note above
),
candidates as (
  select mi.*,
    (select rm.id from roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by = mi.user_id) as claimed_match_id,
    -- Same club + same normalized email, but already claimed by a DIFFERENT
    -- authenticated user. Detected explicitly here as its own conflict
    -- signal — never left for the roster_members_club_email_uniq index to
    -- surface later as an INSERT failure, per instruction.
    (select rm.id from roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is not null
         and rm.claimed_by <> mi.user_id
         and lower(rm.email) = mi.v_email) as email_claimed_by_other_id,
    (select rm.id from roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as email_candidate_id,
    (select rm.first_name from roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_first_name,
    (select rm.last_name from roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_last_name
  from membership_identity mi
),
scored as (
  select c.*,
    -- Per-field corroboration, faithful to the prose: a populated candidate
    -- name field that conflicts with the profile's corresponding field
    -- disqualifies the match even if the OTHER field is null. Only a
    -- populated field that MATCHES (or a null field, which contradicts
    -- nothing) counts as corroborating.
    ( (candidate_first_name is null or lower(candidate_first_name) = lower(first_name))
      and (candidate_last_name  is null or lower(candidate_last_name)  = lower(last_name))
    ) as name_corroborated
  from candidates c
)
select
  case
    when claimed_match_id is not null            then 'A_already_linked'
    when email_claimed_by_other_id is not null    then 'D_conflict_claimed_by_other_user'
    when email_candidate_id is not null
         and name_corroborated                    then 'B_auto_link_candidate'
    when email_candidate_id is not null           then 'D_conflict_name_mismatch'
    else 'C_create_new'
  end as classification,
  count(*)
from scored
group by 1
order by 1;
```

0107 should not be applied while this query's `D_*` rows are nonzero.

---

## 14. Historical Member-Booking Backfill (deferred to the reservations-cutover migration, not 0107)

Once every `club_memberships` row has a corresponding, correctly-linked `roster_members` row (guaranteed by §13's algorithm, including removed memberships), historical `reservations` rows with `reason = 'member_booking'` can be backfilled deterministically and completely — there is no technical reason to leave them in a second, unlinked identity system:

```
UPDATE reservations r
SET    roster_member_id = rm.id
FROM   roster_members rm
WHERE  r.reason = 'member_booking'
  AND  r.roster_member_id IS NULL
  AND  rm.claimed_by = r.owner_user_id
  AND  rm.club_id     = r.club_id;
```

(Design-only — not to be created now.) Scoped by `club_id` in the join (matching the multi-club correctness requirement — the same person's roster identity differs per club). Coverage is guaranteed 100% by construction: every historical `member_booking` row's `owner_user_id` is, by definition of `create_reservation`'s existing authorization checks, an authenticated profile that held a `club_memberships` row in that reservation's `club_id` at the time of booking — and §13's algorithm (run over *all* memberships, including removed ones) guarantees that pairing now has exactly one `roster_members` row. This backfill runs in the same migration that adds `roster_member_id` to `reservations` (§16), not in 0107.

---

## 15. Reservation Subject-Column Resolution

Evaluates the compatibility shape proposed for approval, against §1's proof and this revision's direct constraint checks.

**Terminology decision (see also §17):** the working name `subject_identity_id` from the original draft is **superseded** — the production name is **`roster_member_id`**, matching the one existing precedent already shipped and proven (`event_guests.roster_member_id`), avoiding a second vocabulary word for the same concept, and self-documenting its FK target exactly like every other identity column in this codebase (`owner_user_id`, `profile_id`, `member_id` all name the relationship *and* imply the target table by existing convention).

### Final reservation identity matrix by `reason`

| Case | `roster_member_id` | `owner_user_id` | `created_by` | Confirmed safe? |
|---|---|---|---|---|
| **Self-service Member** (`member_booking`) | stable identity (their own, resolved via the caller's `club_memberships` → linked `roster_members` row) | authenticated Member's own `profiles.id` (unchanged) | same (unchanged) | **Yes.** `create_reservation` gains one additional lookup/insert; existing `owner_user_id = created_by = auth.uid()` behavior is byte-for-byte unchanged. |
| **Staff books for an authenticated Member** (`member_booking`) | stable identity of the target Member | **target Member's `profiles.id`** (not the staff actor) | staff actor's `profiles.id` | **Yes, and requires no nullability change at all** — `owner_user_id` stays `NOT NULL` and is populated with a real profile; this case only needs a new RPC parameter for "which profile is this for," not a schema relaxation. |
| **Staff books for a no-account Member** (`member_booking`) | stable identity of the target no-account Member | **`NULL`** | staff actor's `profiles.id` | **Yes, but requires relaxing `owner_user_id`'s `NOT NULL` — see nullability analysis below.** The staff actor's own id must never be substituted here (explicitly rejected — see below). |
| `maintenance` | **`NULL`, always** | unchanged (admin who ran the RPC — actor/occupancy placeholder) | unchanged | **Yes — no change from today.** No concrete reason found to touch this case; preserved exactly. |
| `admin_block` | **`NULL`, always** | unchanged (dead value, no insert path exists) | unchanged | **Yes — no change; still flagged, not load-bearing.** |
| `event` | **`NULL`, always** | unchanged (event creator — actor/occupancy placeholder) | unchanged | **Yes — no change from today.** Real participants remain in `event_participants` via `event_id`; this column is not the place to record them. |
| `pro_lesson` | **Recommend populating now, not deferred** — the member's stable identity, set in `accept_lesson_proposal` at the same insert that already exists (`0101:469-484`), using the member id already in scope (`auth.uid()` when the member self-accepts, or `v_request.member_id`) | **unchanged — stays the pro's `profiles.id`.** Must not change: `_lesson_check_pro_availability` and every pro-schedule query depend on `owner_user_id` meaning "the pro," and changing it would reintroduce double-booking risk for pros. | unchanged (the accepting member, exactly as today) | **Yes, additive.** `roster_member_id` is independent of `owner_user_id`'s existing semantics, so this can be added without touching the pro-availability logic at all — it only gives reporting/history a correct way to attribute the court time to the member, which is currently impossible without a join through `lesson_requests`. |

### `owner_user_id` nullability — recommendation and exact blast radius

**Recommendation: relax `owner_user_id` from `NOT NULL` to nullable, exercised only for the "staff books for a no-account Member" case.** Every other case (self-service, staff-for-authenticated-Member, `maintenance`/`admin_block`/`event`/`pro_lesson`) continues to always populate a real `owner_user_id` exactly as today — the nullable state is new but remains narrow and exceptional, not a general condition every row or query must now handle.

**Do not substitute the staff actor's id as a fake `owner_user_id`** for a no-account Member's booking, per explicit instruction — confirmed independently as the correct call: doing so would misattribute the booking to staff in every `owner_user_id`-keyed surface (name display, admin "today's bookings" join, any future per-owner reporting), which is a data-integrity corruption, not a convenience. `NULL` is the honest representation: no authenticated profile occupies this slot.

Exact effects, verified by direct inspection this session:

| Area | Effect |
|---|---|
| RLS: `reservations_insert_own` | **No change.** Requires `owner_user_id = auth.uid() AND created_by = auth.uid() AND reason = 'member_booking'` — this policy governs only direct member self-insert and is untouched; the new staff/no-account path is a SECURITY DEFINER RPC that bypasses it, exactly like every other admin-acts-on-behalf-of-member RPC in this codebase. |
| RLS: `reservations_cancel_own` | **No change needed.** Requires `owner_user_id = auth.uid()` for both the `USING` and `WITH CHECK` clauses — a `NULL` `owner_user_id` can never equal any `auth.uid()`, so self-cancellation is automatically and correctly impossible for a no-account Member's booking without any policy edit. Admin cancellation (role-gated, not owner-gated) remains the only path, which is the desired behavior. |
| RLS: `reservations_select_same_club` | **No change.** Club-wide visibility (`club_id = current_user_club_id()`), no dependency on `owner_user_id` — `NULL`-owner rows remain fully visible on the calendar to the whole club. |
| `create_reservation` | **No change.** Remains the self-service-only path; never receives or produces a `NULL` `owner_user_id`. |
| New admin RPC | The only path permitted to insert `NULL` `owner_user_id`, and only when the target `roster_member_id` resolves to an unclaimed identity; when the target is claimed (authenticated), the RPC must set `owner_user_id` to that identity's linked profile — `NULL` is conditional on claim state, never a free choice. |
| `update_member_reservation` / `cancel_member_reservation` / `admin_cancel_reservation(_v2)` | **No change required.** None of these authorize or filter on `owner_user_id IS NOT NULL`; `update_member_reservation` locks by `id + club_id` and never reassigns `owner_user_id`; `admin_cancel_reservation` is role-gated only; `cancel_member_reservation`'s self-owner check naturally excludes `NULL` rows as above. |
| Conflict checks (GiST exclude) | **No change** — confirmed court/time-only, no `owner_user_id` dependency (§1). A **new** no-account-Member double-booking check (preventing the same no-account identity from being booked into two overlapping courts) must be written against `roster_member_id`, since `owner_user_id` will be `NULL` for these rows — new logic, scoped to the reservation-implementation migration, not retrofittable onto existing owner-keyed checks. |
| Calendar rendering | Needs a display fallback: when `owner_user_id` is `NULL`, render the linked `roster_members` identity's name instead of the current `profiles!owner_user_id(...)`-style embed. Real, scoped UI change, deferred to implementation. |
| My Schedule query | **No change, and none needed.** `.eq("owner_user_id", user.id)` is inherently an authenticated-session-only feature; a no-account Member has no session to run it at all — correctly out of scope by construction, not a gap. |
| Admin Overview ("today's bookings") | Same display-fallback need as Calendar (`admin/overview/page.tsx:201-209`), deferred to implementation. |
| Reporting (`get_member_activity_history` etc.) | Currently keys on `owner_user_id = p_member_id`; a no-account Member's bookings (`owner_user_id NULL`) stay invisible until a parallel `roster_member_id`-keyed reporting path exists — already flagged as future work in Phase 33A §11, now concretely explained by nullability rather than only "not wired in yet." |
| Notification dispatch | **No-op by construction, not a regression.** `notifications.user_id` is `NOT NULL → profiles(id)`; no notification can exist for a `NULL`-owner row with no profile behind it. No-account Members have zero communications capability today regardless (Phase 33A §8 item 5); building it is explicitly 33E's scope, unaffected by this decision. |
| TypeScript types | `Database["public"]["Tables"]["reservations"]["Row"/"Insert"/"Update"].owner_user_id` changes from `string` to `string \| null`; every call site currently assuming a defined string (admin overview join, calendar rendering) needs a null-check when implemented. |

---

## 16. Revised Migration 0107 Scope — Still DESIGN ONLY

Unchanged in shape from the prior draft, now backed by §13's full algorithm instead of a blind insert:

Proposed purpose: **"Roster identity foundation — fix cross-club claim uniqueness; establish `roster_members` as the shared identity surface via the classified backfill in §13."**

Proposed operations (conceptual, not final DDL):
1. Change `roster_members.claimed_by`'s uniqueness from global to per-club (composite unique on `(club_id, claimed_by)` or equivalent) — closes the flagged reconciliation gap for Scenario 2 (§6).
2. Run §13's preflight classification query; **do not proceed if any `D_*` rows exist** until each is manually resolved.
3. Apply Classification A (no-op), B (`UPDATE ... SET claimed_by`), and C (`INSERT`) exactly as specified in §13, over **all** `club_memberships` rows including removed ones.
4. Do **not** touch `reservations`, `event_participants`, `program_enrollments`, or `lesson_requests` in this migration — that begins only in the reservation-implementation migration described in §15/§18, informed by real usage of this foundation.

Still additive, still reversible (§19), still testable in isolation.

---

## 17. `claimed_by` / Account-Link Terminology — Final Decision

**Retain `claimed_by`.** (Option A of the three offered: retain and document, not rename.)

Reasoning: the name remains accurate under the evolved architecture — it still literally means "the authenticated account that has claimed/linked this identity," which is exactly as true when `roster_members` represents 100% of Members as it was when it represented only the unclaimed minority. There is no ambiguity being introduced by keeping it; a rename would be cosmetic. Blast radius of renaming would touch working, shipped SQL across at least five migrations (`0056`, `0067`, `0075`, `0083`, `0084`) plus every RPC and TypeScript call site under `admin/members` and `accept_club_invite` — real churn for zero functional or clarity gain, which the instruction explicitly warns against. **Document the meaning precisely instead:** `claimed_by IS NULL` = no-account Member; `claimed_by IS NOT NULL` = linked to an authenticated `profiles`/`auth.users` account. This documentation lives in §12's invariant above and should be carried into the eventual 0107 migration's own header comment, matching this codebase's existing convention of explaining "why," not just "what," in migration preambles.

---

## 18. RPC / Action Changes — Names/Signatures Only, Not Implemented (updated terminology)

- `create_reservation` — new optional parameter, e.g. `p_target_profile_id uuid default null`, for the "staff books for an authenticated Member" case (§15); self-service behavior unchanged when omitted. `roster_member_id` is resolved server-side from the caller's own linked identity, not passed by the client.
- New RPC, e.g. `admin_create_member_reservation(p_court_id, p_starts_at, p_ends_at, p_roster_member_id, p_format, p_player_count, p_guest_names, p_notes)` — admin/pro-only, authorizes actor via `current_user_role()`, resolves `owner_user_id` from the target identity's `claimed_by` (null if unclaimed, per §15's matrix), never accepts a client-supplied `owner_user_id` directly.
- `update_member_reservation` — no signature change anticipated; already admin-authorized and preserves `owner_user_id`.
- `accept_lesson_proposal` — gains a `roster_member_id` write on the reservation it inserts (§15's `pro_lesson` recommendation), resolved from the existing `lesson_requests.member_id`/`auth.uid()` already in scope — no new parameter needed.
- `get_member_activity_history` / admin member-detail RPCs — extend to accept `roster_members.id` in addition to (or instead of) `profiles.id`, and to include `reservations` (closing the separate pre-existing gap noted in Phase 33A §8 item 6).
- No changes anticipated to `join_event`/`leave_event`/`submit_lesson_request`/`add_program_member` self-service paths — this checkpoint is staff-managed-only; self-service RPCs are untouched.

---

## 19. UI Flow (updated terminology)

Admin taps an open Calendar slot → **Book Court** → picker with two explicit options, mirroring the Admin → Members precedent (`AddMemberSheet.tsx`) and the Events roster picker (`EventRosterSheet.tsx`) rather than inventing a new pattern:
- **Club Member with account** — existing `profiles`/`club_memberships` picker, unchanged.
- **Club Member — no account yet** — sources from the identity established in §16, labeled distinctly from Guests, matching the existing "No Account Yet" section language already validated in the Events roster UI.

The reservation form then records: who it's for (the selection above, resolved to `roster_member_id`, with `owner_user_id` populated only if that identity is claimed — §15), who created it (`created_by = auth.uid()`, the admin), club (from the admin's active club context, unchanged), court/time (unchanged), and an optional secondary `guest_names` field for true one-off guests riding along on that booking (unchanged, unrelated mechanism per §8). True Guests are never offered as an alternative to the "no account yet" option — they remain reachable only via the existing secondary guest-name field on the form, not the primary "who is this for" picker.

**Should Pros also book on behalf of Members?** Recommend, do not implement: pros already have relaxed self-booking rules (`0059:92-96`) and already act on behalf of members in the lesson-proposal flow (`propose_lesson_time`), so extending the same admin-style "book for a Member" capability to pros is a small, consistent extension of an existing pattern — but it should ship after the admin path is validated in production, gated by the same `current_user_role() in ('admin','pro')` check already used elsewhere, and scoped to the pro's own club only.

---

## 20. Backward-Compatibility and Rollback Strategy

**Backward compatibility:** everything in §13/§16 (0107's actual scope) is additive from the perspective of existing rows: `claimed_by`'s constraint changes shape but never rejects a previously-valid state; classifications A and C touch nothing or add only new rows; classification B sets a previously-null column on existing unclaimed rows without altering any other field. No existing RLS policy, RPC signature, or `Database` TypeScript type changes as part of 0107 itself. The reservation changes in §15/§18 are scoped to a later, separate migration and are themselves additive: `owner_user_id`/`created_by` keep their current values and meaning for every existing row and every continuing case except the one new no-account-booking path; the new `roster_member_id` column is nullable and unpopulated for historical resource-occupancy rows (`maintenance`/`admin_block`/`event`), populated by backfill for historical `member_booking` rows (§14), and populated going forward per §15's matrix.

**Rollback:** 0107 is reversible in isolation — the `claimed_by` uniqueness change can revert to its prior (global) form if the per-club constraint surfaces an unexpected conflict, and any Classification-C-inserted `roster_members` rows can be deleted (additive, unreferenced by any activity table at this stage, no independent history yet) without touching `profiles`/`club_memberships`/reservation/event/lesson data. Classification-B links (`claimed_by` updates on pre-existing rows) can be reverted to `NULL` if needed, since no other field is touched by that step. Because §14–§18's reservation changes are explicitly deferred past 0107, there is no cross-table cutover step in *this* checkpoint requiring coordinated rollback.

---

## 21. Testing Matrix (updated)

| Area | Test |
|---|---|
| `claimed_by` uniqueness | Same user claims roster rows in two different clubs — now succeeds; same user attempts to claim two roster rows in the *same* club — still rejected. |
| Preflight classification correctness | Every `club_memberships` row (including removed ones) lands in exactly one of A/B/C/D; spot-check known email-collision fixtures land in D, not B; spot-check blank-name candidates land in B, not D. |
| Fail-closed behavior | Migration refuses to proceed (or is not even generated/applied) while any `D_*` row exists in the preflight query; a manually corrected D row reclassifies cleanly to A/B/C on re-run. |
| Backfill idempotency | Re-running the classification algorithm after a successful 0107 apply reclassifies every row as A (already linked) — no duplicate inserts, no duplicate links. |
| No regression on self-service reservations | `create_reservation`, `update_member_reservation`, `cancel_member_reservation` behave identically for existing member/admin/pro flows with new optional parameters omitted. |
| Reservation reason semantics unchanged | `maintenance`/`event` inserts continue to set `owner_user_id`/`created_by` exactly as today and leave `roster_member_id` null; `pro_lesson` inserts continue to set `owner_user_id` to the pro and additionally populate `roster_member_id` for the member; `_lesson_check_member_availability`/`_lesson_check_pro_availability` unaffected. |
| No-account booking creates `NULL owner_user_id` correctly | Staff-created booking for an unclaimed identity produces `owner_user_id IS NULL`, `roster_member_id` set, `created_by` = staff; self-cancel is correctly impossible; admin cancel still works; calendar/overview render the roster identity's name via fallback. |
| Staff-for-authenticated-Member booking | `owner_user_id` = target Member's profile (not staff), `created_by` = staff, `roster_member_id` = target's linked identity — never `NULL owner_user_id` for a claimed target. |
| Historical backfill coverage | Post-backfill, every `reason = 'member_booking'` row has a non-null `roster_member_id`; zero orphaned rows for members whose `club_memberships` was later removed. |
| Cross-club isolation | A no-account identity created in Club A is never visible or bookable from Club B's admin session. |
| No-account vs. Guest distinction | A no-account Member booked via the new picker never appears labeled as a Guest anywhere in roster/reporting UI; a true Guest (via `guest_names`) never gains a persistent identity or history. |

---

## 22. Files Changed

- `docs/DESIGN_phase33b.md` only (this revision). No source, migration, or database files touched.

---

## 23. Recommendation

**Revised 0107 scope (§16) — GO.** The backfill is now a deterministic, fail-closed, preservation-guaranteed algorithm rather than an unsafe blind insert; it is additive, reversible, and testable in isolation, and does not touch any activity table.

**Reservation subject-column design (§15) — GO, as its own follow-up checkpoint**, explicitly deferred out of 0107: add `roster_member_id` to `reservations`, relax `owner_user_id` to nullable (exercised only for the no-account-booking case), run the historical backfill (§14), add the new admin RPC, and update Calendar/Admin-Overview display and reporting — in that order, tested against §21 before moving to `event_participants`/`program_enrollments`/`lesson_requests`, which should reuse this proven shape rather than re-deriving it.

**Explicitly deferred to the reservation-implementation migration (not 0107, not this document's scope to build now):**
- Adding `roster_member_id` to `reservations` and relaxing `owner_user_id`'s `NOT NULL`.
- The new `admin_create_member_reservation`-equivalent RPC and `create_reservation`'s self-service `roster_member_id` auto-population.
- The historical `member_booking` backfill (§14).
- `pro_lesson`'s `roster_member_id` population in `accept_lesson_proposal`.
- Calendar/Admin Overview display fallback for `NULL owner_user_id`.
- Reporting extension to include `roster_member_id`-keyed activity.
- The new no-account double-booking conflict check.

**READY to commit this revision of `DESIGN_phase33b.md`.** Both identified gaps are resolved with a concrete, evidence-grounded algorithm and a single unambiguous invariant; no implementation was performed; nothing beyond this document was changed.
