-- 0107_roster_identity_foundation.sql
-- Phase 33B1: Stable Member Identity Foundation
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 33A (docs/AUDIT_phase33a.md) and Phase 33B (docs/DESIGN_phase33b.md,
-- approved) established that roster_members — not a new table — becomes the
-- permanent, club-scoped Member business identity for Staff-Managed
-- Operations. Locked invariant (DESIGN_phase33b.md §12, restated and
-- extended for invite creation per the Phase 33B1 review that produced this
-- revision):
--
--   Every club a person is meaningfully associated with has exactly one
--   roster_members row representing that person's business identity in that
--   club. That row's id is permanent once created and is never reissued,
--   merged away, or replaced. A profiles/auth.users account optionally links
--   to it through roster_members.claimed_by — claimed_by IS NULL means
--   no-account Member, claimed_by IS NOT NULL means linked/authenticated.
--   club_memberships remains the sole authoritative source of authenticated
--   role/status/authorization and is never treated as an identity table. Any
--   successful creation of a NEW authenticated club_memberships row must have
--   exactly one stable roster_members identity for (club_id, user_id), and
--   that identity must exist BEFORE or atomically with membership creation
--   — never after.
--
-- This migration lays that foundation:
--   1. roster_members.claimed_by's uniqueness changes from GLOBAL to PER-CLUB
--      — a single authenticated user may now hold one linked roster identity
--      per club (multiple clubs allowed), never two in the same club.
--   2. Invite CREATION is made roster-first: club_invites gains
--      roster_member_id; create_club_invite now requires an existing,
--      unclaimed, same-club roster identity instead of a bare email; a new
--      resend_club_invite consolidates revoke+recreate into one transaction
--      and refuses to perpetuate an invite with no roster identity behind
--      it.
--   3. accept_club_invite now resolves the destination club's roster
--      identity BEFORE any irreversible write, and RAISEs — rolling back
--      the whole acceptance, including membership creation — if no safe
--      identity can be resolved. The database is the final safety boundary
--      regardless of how the invite was created.
--   4. Every existing club_memberships row (including removed ones) is
--      classified and, where safe, given a stable roster_members identity —
--      by reusing an already-linked row, safely auto-linking an existing
--      unclaimed row, or creating exactly one new row. Never a blind insert.
--
-- Explicitly OUT OF SCOPE for 0107 (deferred to later Phase 33B checkpoints
-- per DESIGN_phase33b.md §16/§23): no changes to reservations,
-- event_participants, program_enrollments, lesson_requests, event_guests
-- reconciliation, communications, or reporting. No production data is
-- modified by writing this file — this migration is not applied by this
-- checkpoint.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CLASSIFICATION ALGORITHM (backfill — DESIGN_phase33b.md §13, corrected)
-- ═══════════════════════════════════════════════════════════════════════════
-- Every club_memberships row (club_id, user_id), INCLUDING rows with
-- removed_at IS NOT NULL, is classified into exactly one of:
--
--   A_ALREADY_LINKED   — a roster_members row already exists in this club
--                         with claimed_by = this user. Reused as-is; no
--                         mutation.
--   B_SAFE_AUTO_LINK    — no A match; exactly one unclaimed roster_members
--                         row exists in this club whose normalized email
--                         matches the user's normalized auth email, AND
--                         every populated roster name field agrees with the
--                         corresponding profile field. The existing row's id
--                         is preserved; only claimed_by is set.
--   C_CREATE_NEW        — no A match, no email-correlated roster identity at
--                         all. A new roster_members row is created, linked
--                         immediately (claimed_by is certain, not inferred).
--   D_CONFLICT          — never auto-resolved. Covers three distinct causes
--                         (surfaced separately by the preflight script, not
--                         collapsed into one undifferentiated bucket):
--                           • email_name_mismatch    — an email-matching
--                             unclaimed roster row exists but a POPULATED
--                             roster name field disagrees with the profile.
--                             Name corroboration (faithful to design review):
--                               - both roster names blank/null -> no
--                                 contradiction, corroborates;
--                               - only first name populated (on the roster
--                                 row) -> first name alone must match;
--                               - only last name populated -> last name
--                                 alone must match;
--                               - both populated -> both must match;
--                               - any populated field that disagrees, in
--                                 EITHER direction (roster populated vs.
--                                 profile blank, or both populated and
--                                 different) -> conflict, not a corroborated
--                                 match. (The "profile side blank, roster
--                                 side populated" case is an explicit, safety
--                                 -conservative extension beyond the literal
--                                 review wording: there is nothing to compare
--                                 against, so it cannot be corroborated
--                                 either — fail closed rather than guess.)
--                           • claimed_by_other_user  — a roster_members row
--                             in this club with this same normalized email
--                             is ALREADY claimed_by a DIFFERENT authenticated
--                             user. Detected explicitly here, before any
--                             mutation — never left for the
--                             roster_members_club_email_uniq index to
--                             surface later as an unrelated insert failure.
--                           • missing_required_name  — this row would
--                             otherwise be C_CREATE_NEW, but
--                             profiles.first_name or profiles.last_name is
--                             null/blank, and roster_members.first_name/
--                             last_name are NOT NULL. Fabricating a
--                             placeholder name would itself be an
--                             unsubstantiated guess about someone's identity
--                             — that is refused, not silently defaulted.
--
-- Preservation guarantee, by construction: A performs no mutation at all; B
-- links (UPDATE claimed_by) the EXISTING row rather than creating a new one,
-- so any history already attached to that id (e.g. event_guests via
-- roster_member_id) is untouched; only C creates new rows, and only when
-- nothing pre-existing was found to collide with. No existing
-- roster_members.id is ever destroyed, replaced, or merged by this
-- migration.
--
-- Out of scope, explicitly: deduplicating unrelated pre-existing unclaimed
-- roster_members rows (general roster hygiene, not this migration's job);
-- reconciling event_guests rows already tied to a roster_members.id that
-- gets classified A or B here (a separate, already-flagged gap — Phase 33A
-- §8 item 3 — untouched by this migration).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- NULL-SAFETY CORRECTION (post-review fix — SQL three-valued logic bug)
-- ═══════════════════════════════════════════════════════════════════════════
-- The first draft of the classification logic wrote name_corroborated as:
--   (candidate_first_name is null or lower(candidate_first_name) = lower(v_first_name))
--   and (candidate_last_name is null or lower(candidate_last_name) = lower(v_last_name))
-- This is NOT null-safe. When a candidate field is POPULATED but the
-- profile's corresponding field is NULL, `lower(candidate) = lower(null)`
-- evaluates to SQL NULL, not FALSE, and `FALSE OR NULL` is also NULL — so
-- the whole expression resolves to NULL rather than the intended FALSE.
-- Concretely, that NULL then propagated into `not name_corroborated`
-- (itself NULL, not TRUE) inside the D_CONFLICT predicate, and a `WHERE`
-- clause treats NULL the same as "does not match" — so the row was
-- silently excluded from the D_CONFLICT count (the guard would NOT raise),
-- while separately also failing the B-link predicate (same NULL
-- propagation) and the C-insert predicate (excluded there for an
-- unrelated, correct reason — has_email_candidate is EXISTS-based and never
-- NULL). Net effect: such a row matched none of A, B, C, or a counted D —
-- the migration would COMMIT having silently left that membership without
-- any roster identity at all, exactly contradicting the locked invariant.
--
-- Fix: every field-level comparison is restructured so a populated-vs-null
-- mismatch resolves deterministically to FALSE before the equality
-- operator ever runs (`v_first_name is not null and lower(...) = lower(...)`
-- short-circuits to FALSE, never NULL, when v_first_name is null), AND the
-- whole boolean is wrapped in `coalesce(..., false)` as an explicit second
-- layer, AND every consumption site tests `is not true` / `is true` rather
-- than `not x` / `and x`, so even a future edit that reintroduces a bare
-- comparison cannot silently bypass the fail-closed guard.
--
-- Truth table (backfill's batch rule — see the SEPARATE, deliberately more
-- permissive rule for accept_club_invite's real-time claim, documented
-- below under "ACCEPT_CLUB_INVITE INVARIANT AUDIT"):
--
--   Case | Roster first/last | Profile first/last | Result
--   A    | Bob / Smith       | NULL / Smith        | D_CONFLICT (first: Bob populated, profile null -> mismatch, not corroborated)
--   B    | Bob / NULL        | Alice / Jones        | D_CONFLICT (first: Bob<>Alice, both populated, real mismatch)
--   C    | NULL / Smith      | Alice / Jones        | D_CONFLICT (last: Smith<>Jones, both populated, real mismatch)
--   D    | Bob / Smith       | Bob / Smith          | B_SAFE_AUTO_LINK (both fields match)
--   E    | NULL / NULL       | Alice / Jones (or any)| B_SAFE_AUTO_LINK (roster side blank both fields, nothing to contradict)
--
-- Why the batch rule stays this strict (case A is deliberately still a
-- conflict here, not loosened): add_roster_member/add_roster_member_and_
-- invite (0056/0067) both already refuse to create a roster row whose email
-- matches an existing same-club auth-linked profile at INSERT time, so an
-- unclaimed roster row surviving to backfill time with a populated name
-- that contradicts (or is contradicted by the absence of) an existing
-- member's profile name is more likely a genuine identity ambiguity than
-- routine noise — the opposite is true for accept_club_invite's real-time
-- first-acceptance case, where a blank profile name is the expected,
-- universal state, not a survivor of any prior guard.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ACCEPT_CLUB_INVITE INVARIANT AUDIT (onboarding order confirmed from repo
-- evidence, not assumed — and the gap this revision closes)
-- ═══════════════════════════════════════════════════════════════════════════
-- Question: can accept_club_invite create a NEW club_memberships row and
-- return success while no roster_members row exists for that (club_id,
-- user_id)? Traced every path that reaches it:
--
--   • src/app/(auth)/sign-up/SignUpForm.tsx collects ONLY email + password
--     (lines 13-18, 43-47) — no name field exists on this form at all.
--   • On success it immediately calls acceptPendingInviteAction (line 61),
--     which calls the accept_club_invite RPC (join/[code]/actions.ts:100)
--     BEFORE any name has ever been collected.
--   • src/app/(auth)/welcome/WelcomeForm.tsx is the ONLY place
--     first_name/last_name get written (lines 30-33) — and it is only ever
--     reached AFTER accept_club_invite has already returned success
--     (destAfterAccept, join/[code]/actions.ts:41-51, redirects to /welcome
--     only when the name is still blank; there is no gate anywhere in
--     middleware.ts or src/app/(app)/layout.tsx forcing a user back to
--     /welcome on subsequent visits if they navigate away without
--     finishing it — confirmed by grep, both files, zero matches).
--   • handle_new_user() (0001/0034/0079/0083) inserts a bare profiles row
--     with no first_name/last_name column populated at all.
--
--   => For essentially every first-ever invite acceptance, profiles.
--      first_name/last_name ARE NULL at the exact moment accept_club_invite
--      runs. This is the normal, designed onboarding order, not an edge
--      case — confirmed, not guessed. This is WHY accept_club_invite's own
--      name-contradiction rule (below) stays permissive on blank profile
--      names even though the migration RAISEs on a missing roster identity
--      altogether — a blank NAME is routine; a MISSING IDENTITY no longer
--      should be, now that invite creation is roster-first (next section).
--
-- Invite-creation paths inspected (src/app/(app)/admin/members/actions.ts)
-- and how this revision changes each — see also "ROSTER-FIRST INVITATIONS"
-- below for the exact final RPC/UI shape:
--   • add_roster_member_and_invite (0067, "Add and Generate Invite") — was
--     ALREADY roster-first (creates a roster_members row with staff-entered
--     name data before the invite is ever sent). UNCHANGED by this
--     revision — it remains the canonical single-step "new person" path.
--   • createInviteAction / "Send Invite" (InviteSheet.tsx) — investigation
--     found this is reachable from exactly ONE place in the UI: a "Send
--     Invite" button on an EXISTING roster member row (rm.email &&
--     ...MembersClient.tsx:1173-1180, wired to openInviteForRoster, the
--     sheet's only trigger site in the whole codebase — confirmed by grep).
--     So its real product purpose was always "generate a link for a roster
--     Member who already exists" — but the RPC it called (create_club_
--     invite) accepted a free-form, editable email and had NO roster
--     linkage at all, so the form could be altered (email cleared, role
--     switched to admin) into exactly the unsafe unrestricted-invite case.
--     FIXED, not removed: InviteSheet is now bound to the specific
--     roster_member_id it was opened for — the email field is no longer
--     editable, and create_club_invite (rewritten below) requires and
--     records that roster_member_id.
--   • resendInviteAction (actions.ts:305-332) — previously two separate,
--     non-atomic RPC calls (revoke, then create_club_invite with the old
--     invite's bare email) with no roster check at all. FIXED: replaced by
--     a single resend_club_invite RPC (below) that resolves a roster
--     identity first (reusing the old invite's roster_member_id, or
--     healing a legacy email-only invite by exact match), and refuses to
--     resend — returning an actionable error — if none can be resolved.
--   • importInvitesAction / bulk "Generate Invite Links"
--     (ImportMembersSheet.tsx, actions.ts:358-457) — InviteRowInput already
--     collected firstName/lastName per row but only used them for a
--     display string, never persisting them. FIXED (application-source
--     change, made in this checkpoint since the data was already in hand
--     client-side): each row now calls add_roster_member_and_invite instead
--     of create_club_invite directly — roster identity first, per row, same
--     RPC and duplicate-safety logic as the single-add path. No new backend
--     logic was needed; this was purely a matter of calling the RPC that
--     already existed for exactly this purpose.
--
-- Net result: every application code path capable of creating a NEW
-- membership-granting invite now resolves or creates a roster identity
-- before or atomically with invite creation. The one remaining gap is
-- historical: invites already sitting in club_invites, created before this
-- migration, with no roster_member_id and (for a "Send Invite"-created
-- unrestricted invite, no email at all to even attempt healing against.
-- Section "LEGACY OUTSTANDING INVITES" below and
-- supabase/scripts/verify_phase33b1_preflight.sql's new section surface
-- these for mandatory manual operator resolution before 0107 is applied —
-- accept_club_invite itself RAISEs no_roster_identity for any of them if an
-- operator applies 0107 without resolving them first and someone attempts
-- to accept one, so no membership can ever be created without an identity
-- regardless of whether the preflight step was actually followed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROSTER-FIRST INVITATIONS (invite CREATION side of the fix)
-- ═══════════════════════════════════════════════════════════════════════════
-- club_invites gains a nullable roster_member_id (FK to roster_members,
-- ON DELETE SET NULL — an invite outliving its roster row's deletion simply
-- reverts to the legacy email-fallback path at acceptance, never a dangling
-- reference). create_club_invite's signature changes from (p_role, p_email,
-- p_expires_at) to (p_role, p_roster_member_id, p_expires_at) — email is no
-- longer a separate, independently-trusted input; it is always derived from
-- the roster row itself, eliminating any possibility of an invite's email
-- and its roster identity's email silently diverging. The function requires
-- the roster row to belong to the caller's club, be unclaimed, and have a
-- non-null email (an invite must be able to gate who can accept it —
-- matching add_roster_member_and_invite's existing, established
-- email_required rule, not a new restriction).
--
-- A new resend_club_invite(p_old_code, p_expires_at) consolidates the old
-- two-call revoke-then-create client flow into one transaction (closing a
-- latent atomicity gap as a side effect: previously, a revoke succeeding
-- while the create failed left NO valid invite at all) and resolves the
-- roster identity to resend for BEFORE revoking anything: reuse the old
-- invite's own roster_member_id if it is set and still unclaimed;
-- otherwise attempt to heal a legacy email-only invite by an exact,
-- same-club, unclaimed email match; otherwise RAISE roster_identity_
-- required and change nothing — the admin must recreate the invite through
-- the roster-first workflow (Add Member + Invite, or "Send Invite" on an
-- existing roster row) rather than the resend button perpetuating an invite
-- accept_club_invite would only reject anyway.
--
-- Product decision on the standalone InviteSheet: NOT removed — narrowed.
-- It was already reachable only from an existing roster member's row (see
-- the audit above), so binding it to that specific roster_member_id is the
-- smallest safe convergence with "Add Member + Invite," not a parallel
-- second identity-entry form. An admin who wants to invite someone entirely
-- new — including as an admin — now does exactly what section 7's UX
-- principle describes: "Add Member" (role can already be admin in the
-- roster-only mode, AddMemberSheet.tsx:363, unchanged) "→ optionally Send
-- Invite" on that new roster row. add_roster_member_and_invite's existing
-- member/pro-only restriction for its single-step flow is intentionally
-- left untouched (0067's own comment: admin invites keep the elevated-
-- access warning UI, preserved in the now roster-bound InviteSheet) — no
-- new RPC path was needed to cover the admin-invite case because the
-- existing two-step "Add to roster only" then "Send Invite" sequence
-- already covers it once InviteSheet no longer requires a NEW person.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- LEGACY OUTSTANDING INVITES
-- ═══════════════════════════════════════════════════════════════════════════
-- Production may contain pending (not accepted, not revoked, not expired)
-- invites created before this migration with no roster_member_id and no
-- safely-matching same-club unclaimed roster row. These are surfaced,
-- read-only, by a dedicated new section in
-- supabase/scripts/verify_phase33b1_preflight.sql — count, invite id/code,
-- club, email (if present), role, and created_at, without exposing
-- anything from auth.users beyond what the invite row itself already
-- carries. This migration does not attempt to auto-resolve them (no
-- fabricated names, no guessed roster links) — the required operator
-- action is explicit: revoke the legacy invite and recreate it through
-- Add Member + Invite (or Send Invite, once a roster row exists). Because
-- accept_club_invite itself now RAISEs no_roster_identity for any of these
-- if someone attempts to accept one post-migration, they are a resolvable
-- inconvenience (a dead invite link), never a silent invariant violation —
-- but resolving them before applying 0107 is still required practice, not
-- optional, per the preflight script's explicit READY/NOT READY output.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- created_by DECISION FOR CLASSIFICATION C (investigated before writing this)
-- ═══════════════════════════════════════════════════════════════════════════
-- roster_members.created_by is `uuid not null references auth.users(id)`
-- (0056_roster_members.sql:22) — every existing insert path (add_roster_
-- member, add_roster_member_and_invite) sets it to the ADMIN who ran the
-- RPC, because a human admin genuinely performed that insert. Classification
-- C rows have no such actor — this migration, not any specific admin,
-- creates them, and inventing an arbitrary club admin as a false "creator"
-- would misattribute the action to someone who never took it.
--
-- Decision: created_by = the SAME user_id as claimed_by for these rows.
-- Reasoning:
--   • It satisfies the NOT NULL FK truthfully without fabricating any
--     identity (admin, system user, or otherwise) that does not exist.
--   • It is literally true in the only sense available: this identity
--     record was established specifically for, and immediately linked to,
--     this authenticated person.
--   • created_by = claimed_by on a row is a distinguishable, self-consistent
--     signature an operator can recognize as "system-backfilled at Phase
--     33B1" versus a staff-added, still-pending-claim row (where created_by
--     is an admin and claimed_by is null) or a staff-added-then-later-
--     claimed row (created_by is an admin, claimed_by is a different user
--     entirely).
--
-- roster_members.role is also populated from club_memberships.role (not left
-- at the column default of 'member') for the same truthfulness reason — the
-- column is documented as display/intent only (0056_roster_members.sql:27-
-- 31) but there is no reason to under-represent a pro's or admin's actual
-- role when the correct value is already known at insert time.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- NO audit_log ENTRIES ARE WRITTEN BY THE BACKFILL STATEMENTS THEMSELVES
-- ═══════════════════════════════════════════════════════════════════════════
-- audit_log.actor_id is `uuid not null references profiles(id)`
-- (0005_audit_log.sql:13). There is no legitimate actor for a system-run,
-- migration-driven backfill — inventing one would violate the exact same
-- "no invented identity" principle applied to created_by above. This
-- migration's own entry in Supabase's migration history is the record of
-- record for the bulk backfill; per-row audit_log entries are not written
-- for it. (This does NOT apply to the RPC changes elsewhere in this
-- migration — create_club_invite, resend_club_invite, and
-- accept_club_invite all continue to write normal audit_log entries for
-- real, authenticated, actor-driven actions, exactly as before.)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- FAIL-CLOSED BEHAVIOR
-- ═══════════════════════════════════════════════════════════════════════════
-- Two independent fail-closed layers, neither relying on the other or on an
-- operator having run the separate preflight script:
--   1. The backfill's own guard (Section 4 below) independently recomputes
--      the D_CONFLICT predicate and RAISEs, aborting the entire migration
--      transaction, if any existing club_memberships row is unresolvable.
--      No partial backfill, no silent identity merge, no best guess — ever.
--      Sections 5 (B) and 6 (C) additionally re-express their own safe-row
--      predicates directly, so a bug in the guard alone could never cause
--      an unsafe row to be linked or created.
--   2. accept_club_invite (Section 3 below) independently resolves the
--      destination roster identity on EVERY future acceptance and RAISEs —
--      rolling back membership creation, invite consumption, and the
--      active-club change together — if it cannot. This is permanent,
--      ongoing protection, not a one-time migration-time check: even if
--      invite-creation enforcement (Section 2) were ever bypassed by a
--      future bug, no membership could still be created without a roster
--      identity, because the database itself refuses it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- APPLY INSTRUCTIONS
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Run supabase/scripts/verify_phase33b1_preflight.sql against production
--    FIRST. Confirm the backfill's D_CONFLICT count = 0 (resolve per the
--    original guidance: correct a stale claimed_by, determine a genuine
--    roster duplicate and merge/remove it via existing admin tooling, or
--    backfill a missing profiles.first_name/last_name) AND confirm the new
--    legacy-outstanding-invites section is empty (revoke and recreate any
--    listed invite through the roster-first workflow). Re-run until both
--    are clean.
-- 2. Apply this migration in the Supabase SQL Editor (cloud only). NOT
--    applied by this checkpoint.
-- 3. Run supabase/scripts/verify_phase33b1.sql to confirm the result.
--
-- Idempotent to the extent Postgres migration convention allows: re-running
-- this file after a successful apply is safe — every already-linked row is
-- now A_ALREADY_LINKED (Section 4's guard and Sections 5/6's predicates all
-- exclude it), Section 1 uses `drop constraint if exists` / `create unique
-- index if not exists`, Section 2's column/index use `if not exists`, and
-- Sections 5/6 become no-ops on a second run.

begin;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. roster_members.claimed_by uniqueness: GLOBAL -> PER-CLUB
-- ═══════════════════════════════════════════════════════════════════════════
-- The inline `claimed_by uuid unique references auth.users(id) on delete set
-- null` in 0056_roster_members.sql:21 created two separate constraints under
-- Postgres's default naming: a UNIQUE constraint
-- (roster_members_claimed_by_key) and a FOREIGN KEY constraint
-- (roster_members_claimed_by_fkey). Only the UNIQUE constraint is replaced
-- here — the FK and its ON DELETE SET NULL behavior are untouched, per
-- instruction to preserve them absent evidence requiring otherwise (none
-- found).
alter table public.roster_members
  drop constraint if exists roster_members_claimed_by_key;

create unique index if not exists roster_members_club_claimed_by_uniq
  on public.roster_members (club_id, claimed_by)
  where claimed_by is not null;

comment on column public.roster_members.claimed_by is
  'Optional authenticated-account link (Phase 33B1). NULL = no-account
   Member; NOT NULL = linked to this auth.users id. Unique per (club_id,
   claimed_by) — the same authenticated user may link to one roster identity
   per club, and to different roster identities in different clubs.';

-- The existing single-column partial index (roster_members_claimed_by_idx,
-- 0056_roster_members.sql:51-53) is left in place unchanged — it still
-- serves any legitimate global "is this user linked anywhere" lookup and is
-- not redundant with the new composite index, which only serves per-club
-- lookups.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Roster-first invite infrastructure: club_invites.roster_member_id,
--    create_club_invite (rewritten), resend_club_invite (new)
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.club_invites
  add column if not exists roster_member_id uuid references public.roster_members(id) on delete set null;

create index if not exists club_invites_roster_member_id_idx
  on public.club_invites (roster_member_id)
  where roster_member_id is not null;

comment on column public.club_invites.roster_member_id is
  'Phase 33B1: the roster identity this invite is bound to, for every invite
   created via the roster-first workflow. NULL only for legacy invites
   created before this migration — accept_club_invite falls back to an
   email-based match for those, and RAISEs no_roster_identity if none is
   found. See this migration''s "ACCEPT_CLUB_INVITE INVARIANT AUDIT" and
   "LEGACY OUTSTANDING INVITES" header comments.';

-- ─── create_club_invite (rewritten) ─────────────────────────────────────────
-- Admin only, scoped to caller's club. Signature changes from (p_role,
-- p_email, p_expires_at) to (p_role, p_roster_member_id, p_expires_at):
-- email is no longer a separate, independently-trusted input — it is always
-- derived from the roster row, so an invite's email and its roster
-- identity's email can never silently diverge. Requires the roster row to
-- belong to the caller's club, be unclaimed, and have a non-null email
-- (matching add_roster_member_and_invite's existing email_required rule,
-- not a new restriction — an invite must be able to gate who can accept
-- it).
drop function if exists public.create_club_invite(text, text, timestamptz);

create or replace function public.create_club_invite(
  p_role             text,
  p_roster_member_id uuid,
  p_expires_at       timestamptz default now() + interval '7 days'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile   public.profiles%rowtype;
  v_roster    public.roster_members%rowtype;
  v_invite_id uuid;
  v_code      text;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;
  if v_profile.club_id is null then raise exception 'no_club'; end if;

  if p_role not in ('member', 'pro', 'admin') then
    raise exception 'invalid_role';
  end if;

  if p_roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  select * into v_roster
    from public.roster_members
   where id      = p_roster_member_id
     and club_id = v_profile.club_id
   for update;
  if not found                       then raise exception 'roster_member_not_found';         end if;
  if v_roster.claimed_by is not null then raise exception 'roster_member_already_claimed';   end if;
  if v_roster.email is null          then raise exception 'roster_email_required';           end if;

  -- One active pending invite per roster identity at a time. resend_club_
  -- invite always revokes the old one first (in the same transaction), so
  -- this only ever blocks a genuine duplicate attempt, never the normal
  -- resend path.
  if exists (
    select 1 from public.club_invites
     where roster_member_id = p_roster_member_id
       and accepted_at is null
       and revoked_at  is null
       and expires_at  > now()
  ) then
    raise exception 'invite_already_pending';
  end if;

  insert into public.club_invites (club_id, role, email, roster_member_id, created_by, expires_at)
  values (
    v_profile.club_id,
    p_role,
    v_roster.email,
    p_roster_member_id,
    auth.uid(),
    p_expires_at
  )
  returning id, code into v_invite_id, v_code;

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'create_invite',
    'club_invite',
    v_invite_id,
    jsonb_build_object('role', p_role, 'roster_member_id', p_roster_member_id, 'expires_at', p_expires_at)
  );

  return v_code;
end;
$$;

revoke execute on function public.create_club_invite(text, uuid, timestamptz) from public, anon;
grant  execute on function public.create_club_invite(text, uuid, timestamptz) to authenticated;

-- ─── resend_club_invite (new) ───────────────────────────────────────────────
-- Admin only, scoped to caller's club. Consolidates the old two-call
-- revoke-then-create client flow into one transaction (closes a latent
-- atomicity gap as a side effect: previously a revoke succeeding while the
-- create failed left NO valid invite at all). Resolves the roster identity
-- to resend for BEFORE revoking anything: reuses the old invite's own
-- roster_member_id if still unclaimed; otherwise attempts to heal a legacy
-- email-only invite by an exact, same-club, unclaimed email match;
-- otherwise RAISEs roster_identity_required and changes nothing — the old
-- invite stays exactly as it was, and the admin must recreate it through
-- the roster-first workflow rather than resend perpetuating an invite
-- accept_club_invite would only reject anyway.
create or replace function public.resend_club_invite(
  p_old_code   text,
  p_expires_at timestamptz default now() + interval '7 days'
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile          public.profiles%rowtype;
  v_old_invite       public.club_invites%rowtype;
  v_roster_member_id uuid;
  v_new_code         text;
begin
  select * into v_profile from public.profiles where id = auth.uid();
  if not found then raise exception 'not_authenticated'; end if;
  if v_profile.role <> 'admin' then raise exception 'insufficient_role'; end if;

  select * into v_old_invite
    from public.club_invites
   where code    = p_old_code
     and club_id = v_profile.club_id
   for update;
  if not found                            then raise exception 'invalid_invite';          end if;
  if v_old_invite.accepted_at is not null then raise exception 'invite_already_accepted'; end if;

  -- Resolve the roster identity to resend for BEFORE touching anything.
  if v_old_invite.roster_member_id is not null
     and exists (
       select 1 from public.roster_members
        where id = v_old_invite.roster_member_id
          and claimed_by is null
     )
  then
    v_roster_member_id := v_old_invite.roster_member_id;
  elsif v_old_invite.email is not null then
    -- Legacy email-only invite: heal it if exactly one safe match exists.
    select id into v_roster_member_id
      from public.roster_members
     where club_id      = v_profile.club_id
       and claimed_by   is null
       and lower(email) = lower(v_old_invite.email)
     limit 1;
  end if;

  if v_roster_member_id is null then
    raise exception 'roster_identity_required';
  end if;

  -- Revoke the old invite. Idempotent — harmless if already revoked/expired,
  -- matching the prior client-side "errors ignored" behavior, now enforced
  -- server-side in the same transaction instead of a separate round trip.
  update public.club_invites
     set revoked_at = coalesce(revoked_at, now())
   where id = v_old_invite.id;

  -- Reuse create_club_invite rather than duplicating its insert/validation
  -- logic — same roster identity, same role as the original invite. Runs in
  -- the same transaction: if this raises, the revoke above rolls back too,
  -- so a failed resend never leaves the admin with zero valid invites.
  v_new_code := public.create_club_invite(v_old_invite.role, v_roster_member_id, p_expires_at);

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_profile.club_id,
    auth.uid(),
    'resend_invite',
    'club_invite',
    v_old_invite.id,
    jsonb_build_object(
      'roster_member_id',      v_roster_member_id,
      'healed_legacy_invite',  v_old_invite.roster_member_id is null
    )
  );

  return v_new_code;
end;
$$;

revoke execute on function public.resend_club_invite(text, timestamptz) from public, anon;
grant  execute on function public.resend_club_invite(text, timestamptz) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. accept_club_invite — resolve the roster identity BEFORE any
--    irreversible write; RAISE (rolling back everything) if it cannot be
--    resolved safely. Supersedes the prior "skip the auto-link, still
--    create the membership" design for the D_CONFLICT case (see
--    "ACCEPT_CLUB_INVITE INVARIANT AUDIT" above for why that is now safe to
--    change: invite creation is roster-first as of this same migration, so
--    reaching this failure is no longer the routine state it used to be).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.accept_club_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite            public.club_invites%rowtype;
  v_profile           public.profiles%rowtype;
  v_club              public.clubs%rowtype;
  v_auth_email        text;
  v_existing          public.club_memberships%rowtype;
  v_roster            public.roster_members%rowtype;
  -- Phase 33B1: true only when BOTH the roster row's and the profile's
  -- corresponding name field are populated AND disagree. A blank field on
  -- either side is never treated as a contradiction here — deliberately a
  -- more permissive rule than the backfill's batch classification (see the
  -- migration header's two truth tables). Verified against this repo's
  -- actual onboarding order: profiles.first_name/last_name are NULL for
  -- essentially every first-ever invite acceptance, by design, not by
  -- exception. Treating that routine blank state as a conflict here would
  -- break the "Add Member + Invite" flow for every brand-new Member.
  v_names_contradict  boolean;
begin
  -- Lock order: caller's own profiles row first (see 0084 header comment).
  select p.* into v_profile from public.profiles p where p.id = auth.uid() for update;
  if not found then raise exception 'not_authenticated'; end if;

  -- Lock the invite row second, exactly as before.
  select * into v_invite from public.club_invites where code = p_code for update;

  if not found                        then raise exception 'invalid_invite';  end if;
  if v_invite.revoked_at  is not null then raise exception 'invite_revoked';  end if;
  if v_invite.accepted_at is not null then raise exception 'invite_used';     end if;
  if v_invite.expires_at < now()      then raise exception 'invite_expired';  end if;

  select email into v_auth_email from auth.users where id = auth.uid();

  -- Email restriction: unchanged normalization (case-insensitive compare).
  if v_invite.email is not null then
    if lower(v_auth_email) <> lower(v_invite.email) then
      raise exception 'email_mismatch';
    end if;
  end if;

  -- Never a caller-controlled user id: every membership lookup/write below
  -- is scoped to auth.uid(), never to any value derived from p_code or any
  -- other input.
  select cm.* into v_existing
    from public.club_memberships cm
   where cm.user_id = auth.uid()
     and cm.club_id = v_invite.club_id;

  if found then
    if v_existing.status = 'active' and v_existing.removed_at is null then
      raise exception 'already_member';
    else
      raise exception 'membership_state_conflict';
    end if;
  end if;

  -- ═══════════════════════════════════════════════════════════════════════
  -- Resolve the destination club's stable roster identity BEFORE any
  -- irreversible write (membership INSERT, invite consumption, active-club
  -- change). Outcomes, exactly as specified:
  --   A_ALREADY_LINKED     — a roster row in this club already has
  --                          claimed_by = auth.uid(). Reuse it.
  --   B_SAFE_ROSTER_LINK   — an unclaimed roster row resolves, either
  --                          directly via v_invite.roster_member_id (set by
  --                          create_club_invite for every roster-first
  --                          invite) or, for a legacy email-only invite, by
  --                          exact email match — AND its populated name
  --                          field(s) do not contradict the profile.
  --   C_NO_ROSTER_IDENTITY — neither resolves. RAISE. Because invite
  --                          creation is now roster-first (Section 2), this
  --                          should no longer be a normal production path
  --                          — reachable only via a legacy pre-migration
  --                          invite that a resolved preflight should have
  --                          caught, or a direct RPC call bypassing the
  --                          application entirely.
  --   D_IDENTITY_CONFLICT  — a candidate exists but is claimed by a
  --                          different user, or its populated name(s)
  --                          genuinely contradict the profile. RAISE.
  -- ═══════════════════════════════════════════════════════════════════════

  -- A_ALREADY_LINKED — checked first, regardless of how the invite itself
  -- is shaped. `found` below reflects this select.
  select * into v_roster
    from public.roster_members
   where club_id    = v_invite.club_id
     and claimed_by = auth.uid()
   for update;

  if not found then
    if v_invite.roster_member_id is not null then
      -- Roster-first invite: identity is explicit, not inferred by email.
      select * into v_roster
        from public.roster_members
       where id      = v_invite.roster_member_id
         and club_id = v_invite.club_id
       for update;

      if found and v_roster.claimed_by is not null then
        -- Already claimed by a DIFFERENT user than the one accepting now.
        raise exception 'roster_identity_conflict';
      end if;
    elsif v_auth_email is not null then
      -- Legacy email-only invite: the pre-33B1 lookup, unchanged in shape.
      select * into v_roster
        from public.roster_members
       where club_id     = v_invite.club_id
         and claimed_by  is null
         and lower(email) = lower(v_auth_email)
       limit 1
       for update;
    end if;

    if v_roster.id is null then
      -- C_NO_ROSTER_IDENTITY.
      raise exception 'no_roster_identity';
    end if;

    -- Null-safe, asymmetric contradiction check.
    v_names_contradict := coalesce(
      (v_roster.first_name is not null and v_profile.first_name is not null
        and lower(btrim(v_roster.first_name)) <> lower(btrim(v_profile.first_name)))
      or
      (v_roster.last_name is not null and v_profile.last_name is not null
        and lower(btrim(v_roster.last_name)) <> lower(btrim(v_profile.last_name))),
      false
    );

    if v_names_contradict is true then
      -- D_IDENTITY_CONFLICT.
      raise exception 'roster_identity_conflict';
    end if;
  end if;

  -- v_roster is now guaranteed: a real, safe (A or B) roster identity row,
  -- locked FOR UPDATE. Proceed with the writes.

  -- Create the destination membership. Preserves provenance (invited_by,
  -- source_invite_id) exactly as the schema supports. Never touches any
  -- other club's membership row — an existing membership elsewhere (e.g.
  -- Club A) is not read, written, or referenced anywhere in this function.
  insert into public.club_memberships (
    user_id, club_id, role, status, invited_by, source_invite_id
  ) values (
    auth.uid(), v_invite.club_id, v_invite.role, 'active', v_invite.created_by, v_invite.id
  );

  update public.club_invites
     set accepted_at = now(),
         accepted_by = auth.uid()
   where id = v_invite.id;

  -- Activate the newly created membership in the same transaction, reusing
  -- set_active_club's own validated switch (0082) rather than re-deriving
  -- its logic. The target row is guaranteed to exist and be valid at this
  -- point (just inserted, above, and still locked by this transaction), so
  -- this call cannot legitimately fail. Migration 0081's Trigger C performs
  -- the legacy profiles.club_id/role/status/is_lesson_provider projection
  -- as part of that same call — no direct profiles membership-field write
  -- happens in this function.
  perform public.set_active_club(v_invite.club_id);

  select * into v_club from public.clubs where id = v_invite.club_id;

  -- Audit: invite accepted. Scoped to the destination club only — never
  -- written against any other club the caller may belong to.
  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_invite.club_id,
    auth.uid(),
    'accept_invite',
    'profile',
    auth.uid(),
    jsonb_build_object('role', v_invite.role, 'invite_id', v_invite.id)
  );

  -- Claim the resolved roster identity. No-op if it was already
  -- A_ALREADY_LINKED to this exact user (claimed_by already correct);
  -- updated_at still refreshes harmlessly in that case.
  update public.roster_members
     set claimed_by = auth.uid(),
         updated_at = now()
   where id = v_roster.id;

  -- Global identity fields only (first_name/last_name/phone) — never
  -- club-scoped, unaffected by which club is being joined. Never overwrites
  -- a meaningful existing value the member has already entered.
  update public.profiles
     set first_name = case when btrim(coalesce(first_name, '')) = '' then v_roster.first_name else first_name end,
         last_name  = case when btrim(coalesce(last_name,  '')) = '' then v_roster.last_name  else last_name  end,
         phone      = case when btrim(coalesce(phone,      '')) = '' then v_roster.phone      else phone      end,
         updated_at = now()
   where id = auth.uid();

  insert into public.audit_log (club_id, actor_id, action, target_type, target_id, metadata)
  values (
    v_invite.club_id,
    auth.uid(),
    'claim_roster_member',
    'roster_member',
    v_roster.id,
    jsonb_build_object('invite_id', v_invite.id)
  );

  return jsonb_build_object(
    'club_id',   v_invite.club_id,
    'role',      v_invite.role,
    'club_name', v_club.name
  );
end;
$$;

revoke execute on function public.accept_club_invite(text) from public, anon;
grant  execute on function public.accept_club_invite(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Fail-closed guard (backfill) — independently re-verifies zero
--    D_CONFLICT rows before any backfill statement runs. See "FAIL-CLOSED
--    BEHAVIOR" above.
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_conflict_count int;
begin
  with membership_identity as (
    select
      cm.club_id,
      cm.user_id,
      lower(trim(u.email))              as v_email,
      nullif(btrim(p.first_name), '')   as v_first_name,
      nullif(btrim(p.last_name),  '')   as v_last_name
    from public.club_memberships cm
    join public.profiles p  on p.id = cm.user_id
    join auth.users u       on u.id = cm.user_id
    -- Deliberately no removed_at filter — every membership is classified,
    -- including removed ones, per the locked architecture.
  ),
  candidates as (
    select
      mi.club_id,
      mi.user_id,
      mi.v_first_name,
      mi.v_last_name,
      exists (
        select 1 from public.roster_members rm
         where rm.club_id = mi.club_id and rm.claimed_by = mi.user_id
      ) as is_already_linked,
      exists (
        select 1 from public.roster_members rm
         where rm.club_id     = mi.club_id
           and rm.claimed_by  is not null
           and rm.claimed_by <> mi.user_id
           and lower(rm.email) = mi.v_email
      ) as claimed_by_other_user,
      (select rm.id from public.roster_members rm
         where rm.club_id = mi.club_id and rm.claimed_by is null
           and lower(rm.email) = mi.v_email) as email_candidate_id,
      (select nullif(btrim(rm.first_name), '') from public.roster_members rm
         where rm.club_id = mi.club_id and rm.claimed_by is null
           and lower(rm.email) = mi.v_email) as candidate_first_name,
      (select nullif(btrim(rm.last_name), '') from public.roster_members rm
         where rm.club_id = mi.club_id and rm.claimed_by is null
           and lower(rm.email) = mi.v_email) as candidate_last_name
    from membership_identity mi
  ),
  scored as (
    select c.*,
      -- NULL-SAFE by construction: each field-level clause short-circuits to
      -- a deterministic FALSE (never NULL) whenever one side is populated
      -- and the other is null, because "populated is not null" is itself
      -- evaluated and ANDed in before the equality comparison ever runs.
      -- Belt-and-suspenders: also wrapped in coalesce(..., false) so this
      -- column can never be NULL even if a future edit reintroduces a bare
      -- comparison. See migration header's truth table (cases A-E) for
      -- worked examples of every null/mismatch combination.
      coalesce(
        ( (candidate_first_name is null
           or (c.v_first_name is not null and lower(candidate_first_name) = lower(c.v_first_name)))
          and (candidate_last_name is null
           or (c.v_last_name is not null and lower(candidate_last_name) = lower(c.v_last_name)))
        ),
        false
      ) as name_corroborated
    from candidates c
  )
  select count(*) into v_conflict_count
    from scored s
   where not s.is_already_linked
     and (
       s.claimed_by_other_user
       -- IS NOT TRUE (not "not x"): defense in depth so three-valued SQL
       -- logic cannot let an unresolved comparison silently bypass the
       -- fail-closed guard, even though name_corroborated is now
       -- guaranteed boolean by construction above.
       or (s.email_candidate_id is not null and s.name_corroborated is not true)
       or (s.email_candidate_id is null and (s.v_first_name is null or s.v_last_name is null))
     );

  if v_conflict_count > 0 then
    raise exception
      'phase33b1_unresolved_identity_conflicts: % club_memberships row(s) classify as D_CONFLICT. Run supabase/scripts/verify_phase33b1_preflight.sql for per-row detail, resolve every conflict manually, then re-run this migration. No partial backfill will be applied.',
      v_conflict_count;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Classification B — safe auto-link of existing unclaimed roster rows.
--    Preserves the existing roster_members.id; only claimed_by/updated_at
--    change. Never overwrites existing name/email/phone data.
-- ═══════════════════════════════════════════════════════════════════════════
with membership_identity as (
  select
    cm.club_id,
    cm.user_id,
    lower(trim(u.email))              as v_email,
    nullif(btrim(p.first_name), '')   as v_first_name,
    nullif(btrim(p.last_name),  '')   as v_last_name
  from public.club_memberships cm
  join public.profiles p  on p.id = cm.user_id
  join auth.users u       on u.id = cm.user_id
),
candidates as (
  select
    mi.club_id,
    mi.user_id,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by = mi.user_id
    ) as is_already_linked,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id     = mi.club_id
         and rm.claimed_by  is not null
         and rm.claimed_by <> mi.user_id
         and lower(rm.email) = mi.v_email
    ) as claimed_by_other_user,
    (select rm.id from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as email_candidate_id,
    (select nullif(btrim(rm.first_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_first_name,
    (select nullif(btrim(rm.last_name), '') from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email) as candidate_last_name,
    mi.v_first_name,
    mi.v_last_name
  from membership_identity mi
),
safe_b as (
  -- Same null-safe, coalesced-to-boolean construction as Section 4's guard
  -- (kept inline rather than a separate name_corroborated column, since
  -- this CTE selects only the two columns the UPDATE needs). A row only
  -- lands here if Section 4 already proved it is NOT a D_CONFLICT — this
  -- predicate is intentionally re-derived, not assumed, so a bug in the
  -- guard alone could never cause an unsafe link.
  select c.user_id, c.email_candidate_id as roster_id
  from candidates c
  where not c.is_already_linked
    and not c.claimed_by_other_user
    and c.email_candidate_id is not null
    and coalesce(
          (c.candidate_first_name is null
            or (c.v_first_name is not null and lower(c.candidate_first_name) = lower(c.v_first_name)))
          and (c.candidate_last_name is null
            or (c.v_last_name is not null and lower(c.candidate_last_name) = lower(c.v_last_name))),
          false
        ) is true
)
update public.roster_members rm
   set claimed_by = safe_b.user_id,
       updated_at = now()
  from safe_b
 where rm.id = safe_b.roster_id;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Classification C — create exactly one new roster_members row per
--    unmatched membership. claimed_by set immediately (certain, not
--    inferred). See "created_by DECISION" above for the created_by = user_id
--    choice, and role backfilled from club_memberships.role for accuracy.
-- ═══════════════════════════════════════════════════════════════════════════
with membership_identity as (
  select
    cm.club_id,
    cm.user_id,
    cm.role                           as v_role,
    lower(trim(u.email))              as v_email,
    u.email                           as v_email_raw,
    nullif(btrim(p.first_name), '')   as v_first_name,
    nullif(btrim(p.last_name),  '')   as v_last_name,
    p.phone                           as v_phone
  from public.club_memberships cm
  join public.profiles p  on p.id = cm.user_id
  join auth.users u       on u.id = cm.user_id
),
candidates as (
  select
    mi.*,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by = mi.user_id
    ) as is_already_linked,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id     = mi.club_id
         and rm.claimed_by  is not null
         and rm.claimed_by <> mi.user_id
         and lower(rm.email) = mi.v_email
    ) as claimed_by_other_user,
    exists (
      select 1 from public.roster_members rm
       where rm.club_id = mi.club_id and rm.claimed_by is null
         and lower(rm.email) = mi.v_email
    ) as has_email_candidate
  from membership_identity mi
),
safe_c as (
  select c.club_id, c.user_id, c.v_role, c.v_email_raw, c.v_first_name, c.v_last_name, c.v_phone
  from candidates c
  where not c.is_already_linked
    and not c.claimed_by_other_user
    and not c.has_email_candidate
    and c.v_first_name is not null
    and c.v_last_name  is not null
)
insert into public.roster_members (club_id, first_name, last_name, email, phone, role, claimed_by, created_by)
select
  safe_c.club_id,
  safe_c.v_first_name,
  safe_c.v_last_name,
  safe_c.v_email_raw,
  safe_c.v_phone,
  safe_c.v_role,
  safe_c.user_id,
  safe_c.user_id
from safe_c;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Rollback procedure (documentation only — no rollback migration is created
-- in this checkpoint)
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. accept_club_invite: CREATE OR REPLACE FUNCTION back to the 0084 body
--    (0084_additional_club_invitation_acceptance.sql) to fully revert to
--    the pre-33B1 "email-match only, skip-don't-abort" behavior.
-- 2. create_club_invite / resend_club_invite: `drop function if exists
--    public.resend_club_invite(text, timestamptz);` then restore create_
--    club_invite's pre-33B1 (p_role, p_email, p_expires_at) signature via
--    `drop function if exists public.create_club_invite(text, uuid,
--    timestamptz);` followed by CREATE OR REPLACE with the 0032 body.
--    Existing invites with roster_member_id set are unaffected either way
--    — the column is simply no longer read by the reverted function.
-- 3. club_invites.roster_member_id: `alter table public.club_invites drop
--    column if exists roster_member_id;` — safe; ON DELETE SET NULL means
--    no roster_members row depends on this column existing.
-- 4. Section 1's index: `drop index if exists
--    roster_members_club_claimed_by_uniq;` then restore the original
--    single-column global unique constraint with
--    `alter table public.roster_members add constraint
--    roster_members_claimed_by_key unique (claimed_by);` — this will FAIL if
--    any Classification-B links created by Sections 5/6 have since put two
--    roster_members rows (in different clubs) under the same claimed_by;
--    that is expected and correct — it means real multi-club linkage now
--    exists and a global constraint can no longer represent the data
--    truthfully. Do not force it through with a partial delete.
-- 5. Sections 5/6's backfilled data: Classification C rows are safe to
--    delete (`delete from public.roster_members where created_by = claimed_by
--    and created_at >= '<migration apply timestamp>'`) since they carry no
--    independent history yet at the time of this migration. Classification B
--    links can be reverted with `update public.roster_members set claimed_by
--    = null, updated_at = now() where id in (<ids captured from
--    verify_phase33b1.sql's output at apply time>)` — no other column was
--    touched by a B link, so this fully reverts it. No club_memberships,
--    profiles, or auth.users row is touched anywhere in this migration, so
--    none needs rollback.
